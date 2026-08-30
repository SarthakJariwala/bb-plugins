import {
  definePluginApp,
  useComposer,
  useSettings,
  type PluginThreadHeaderActionProps,
} from "@bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { getShipOptions } from "./prompts";
import "./app.css";

function ShipHeaderButton({ isCompactViewport }: PluginThreadHeaderActionProps) {
  const composer = useComposer();
  const { values: settings } = useSettings();
  const shipOptions = getShipOptions(settings);

  function copyPrompt(prompt: string) {
    composer.setText(prompt);
    requestAnimationFrame(() => composer.focus());
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={isCompactViewport ? "icon" : "sm"}
          className="ship-trigger relative h-7 overflow-hidden"
          aria-label="Ship changes"
        >
          <span className="relative z-[1]">{isCompactViewport ? "S" : "Ship"}</span>
          {!isCompactViewport ? (
            <Icon name="ChevronDown" className="relative z-[1] size-3.5 text-muted-foreground" />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" mobileTitle="Ship changes">
        {shipOptions.map((option) => (
          <DropdownMenuItem key={option.value} onSelect={() => copyPrompt(option.prompt)}>
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "ship-header",
    title: "Ship changes",
    component: ShipHeaderButton,
  });
});
