import {
  definePluginApp,
  useComposer,
  type PluginThreadHeaderActionProps,
} from "@bb/plugin-sdk/app";
import { SHIP_OPTIONS } from "./prompts";
import "./app.css";

function ShipHeaderButton({ isCompactViewport }: PluginThreadHeaderActionProps) {
  const composer = useComposer();

  function copyPrompt(prompt: string) {
    composer.setText(prompt);
    composer.focus();
  }

  return (
    <select
      value=""
      aria-label="Ship changes"
      className={
        isCompactViewport
          ? "ship-select ship-select-compact h-7 w-7 cursor-pointer appearance-none rounded-md border-0 bg-transparent text-center text-xs font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          : "ship-select h-7 w-[4.5rem] cursor-pointer appearance-none rounded-md border-0 bg-transparent pl-3 pr-6 text-left text-xs font-medium hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      }
      onChange={(event) => {
        const option = SHIP_OPTIONS.find(({ value }) => value === event.target.value);
        if (option) copyPrompt(option.prompt);
      }}
    >
      <option value="" disabled hidden>
        {isCompactViewport ? "S" : "Ship"}
      </option>
      {SHIP_OPTIONS.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "ship-header",
    title: "Ship changes",
    component: ShipHeaderButton,
  });
});
