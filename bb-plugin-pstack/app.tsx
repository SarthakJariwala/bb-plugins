import { useCallback, useEffect, useState } from "react";
import {
  definePluginApp,
  experimental_ProviderModelPicker as ProviderModelPicker,
  UrlLink,
  useRealtime,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import type { rpcContract } from "./server";
import type { ModelConfig, ModelSelection, RoleId } from "./model-config";

function cloneConfig(config: ModelConfig): ModelConfig {
  return Object.fromEntries(
    Object.entries(config).map(([role, selections]) => [
      role,
      selections.map((selection) => ({ ...selection })),
    ]),
  ) as ModelConfig;
}

function ModelChoice({
  selection,
  onChange,
}: {
  selection: ModelSelection;
  onChange: (selection: ModelSelection) => void;
}) {
  return (
    <ProviderModelPicker
      value={selection}
      onChange={(value) =>
        onChange({
          providerId: value.providerId,
          model: value.model,
          reasoningLevel: value.reasoningLevel,
          ...(value.serviceTier === undefined ? {} : { serviceTier: value.serviceTier }),
        })
      }
    />
  );
}

function PstackInfo() {
  return (
    <div className="space-y-2 text-sm">
      <p>
        pstack is by Lauren Tan. This BB port keeps the original workflows while running delegated
        work through visible BB child threads.
      </p>
      <UrlLink
        href="https://github.com/cursor/plugins/tree/main/pstack"
        className="inline-flex text-foreground underline underline-offset-4"
      >
        View the original pstack plugin for Cursor
      </UrlLink>
    </div>
  );
}

function PstackSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<ModelConfig | null>(null);
  const [roles, setRoles] = useState<
    Array<{ id: RoleId; label: string; description: string; panel: boolean }>
  >([]);
  const [savedConfig, setSavedConfig] = useState<ModelConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("config_get").then(
      (result) => {
        const next = result.config as ModelConfig;
        setRoles(result.roles as typeof roles);
        setConfig(cloneConfig(next));
        setSavedConfig(cloneConfig(next));
        setError(null);
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  }, [rpc]);

  useEffect(load, [load]);
  useRealtime("model-config-changed", load);

  const updateSelection = (role: RoleId, index: number, selection: ModelSelection) => {
    setConfig((current) => {
      if (current === null) return current;
      const next = cloneConfig(current);
      next[role][index] = selection;
      return next;
    });
  };

  const addSelection = (role: RoleId) => {
    setConfig((current) => {
      if (current === null) return current;
      const next = cloneConfig(current);
      next[role].push({ ...next[role][next[role].length - 1]! });
      return next;
    });
  };

  const removeSelection = (role: RoleId, index: number) => {
    setConfig((current) => {
      if (current === null || current[role].length === 1) return current;
      const next = cloneConfig(current);
      next[role].splice(index, 1);
      return next;
    });
  };

  const dirty =
    config !== null && savedConfig !== null && JSON.stringify(config) !== JSON.stringify(savedConfig);

  const save = async () => {
    if (config === null || saving) return;
    setSaving(true);
    try {
      const result = await rpc.call("config_save", { config });
      const saved = result.config as ModelConfig;
      setConfig(cloneConfig(saved));
      setSavedConfig(cloneConfig(saved));
      toast.success("Pstack model configuration saved");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const reset = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const result = await rpc.call("config_reset");
      const defaults = result.config as ModelConfig;
      setConfig(cloneConfig(defaults));
      setSavedConfig(cloneConfig(defaults));
      toast.success("Pstack models reset to defaults");
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  if (error !== null) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (config === null) {
    return <p className="text-sm text-muted-foreground">Loading model roles…</p>;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Every pstack worker is a visible BB child thread. Spawns return immediately, and required
          workers must be collected before dependent work. Pick a provider and model for scalar
          roles. Panel roles launch one child per entry.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => void reset()} disabled={saving}>
            Reset
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>

      <div className="grid gap-3">
        {roles.map((role) => (
          <Card key={role.id}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">{role.label}</CardTitle>
              <CardDescription>{role.description}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {config[role.id].map((selection, index) => (
                <div key={`${role.id}-${index}`} className="flex min-w-0 items-center gap-2">
                  {role.panel ? (
                    <span className="w-6 shrink-0 text-right font-mono text-xs text-muted-foreground">
                      {index + 1}
                    </span>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <ModelChoice
                      selection={selection}
                      onChange={(next) => updateSelection(role.id, index, next)}
                    />
                  </div>
                  {role.panel ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-8"
                      disabled={config[role.id].length === 1}
                      aria-label={`Remove ${role.label} entry ${index + 1}`}
                      onClick={() => removeSelection(role.id, index)}
                    >
                      <Icon name="Trash2" className="size-4" />
                    </Button>
                  ) : null}
                </div>
              ))}
              {role.panel && config[role.id].length < 12 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => addSelection(role.id)}
                >
                  <Icon name="Plus" className="size-4" />
                  Add model
                </Button>
              ) : null}
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex justify-end">
        <Button onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save model configuration"}
        </Button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "about",
    title: "About pstack",
    component: PstackInfo,
  });
  app.slots.settingsSection({
    id: "model-roles",
    title: "Model roles",
    description: "Configure the providers, models, and reasoning levels used by pstack workflows.",
    component: PstackSettings,
  });
});
