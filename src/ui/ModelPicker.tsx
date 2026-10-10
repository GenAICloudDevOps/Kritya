import { Box, Text } from "ink";
import { CURATED_MODELS, providerOfModel, type ModelInfo } from "../config/models.js";
import { SelectList, type SelectItem } from "./SelectList.js";

/** Provider label for a hint, e.g. `groq` — what the user would pass to `-p`. */
function providerHint(m: ModelInfo): string {
  return providerOfModel(m);
}

export function ModelPicker({
  current,
  provider,
  customModels,
  onSelect,
  onCancel,
}: {
  current: string;
  /** Active provider name, used to filter and group the curated list. */
  provider: string;
  customModels: { id: string; label?: string }[];
  onSelect(modelId: string): void;
  onCancel(): void;
}) {
  // Show the active provider's models first and unlabelled, then any other
  // providers' under a `provider/` prefix — so a Groq user sees Groq models
  // at the top, and an NVIDIA user still sees the rest without the picker
  // silently hiding them or lying about which provider they belong to.
  const own = CURATED_MODELS.filter((m) => providerOfModel(m) === provider);
  const others = CURATED_MODELS.filter((m) => providerOfModel(m) !== provider);
  // Fall back to the whole list when the active provider has no curated
  // models, so the picker is never empty.
  const listed: ModelInfo[] = own.length > 0 ? [...own, ...others] : CURATED_MODELS;

  const items: SelectItem[] = [
    ...listed.map((m) => ({
      label: m.label + (m.id === current ? " (current)" : ""),
      value: m.id,
      hint: `${m.id} · ${providerHint(m)}${m.note ? ` · ${m.note}` : ""}`,
    })),
    ...customModels.map((m) => ({
      label: (m.label ?? m.id) + (m.id === current ? " (current)" : ""),
      value: m.id,
      hint: `${m.id} · custom`,
    })),
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text bold color="magenta">
        Select model{" "}
        <Text dimColor>(Esc to cancel, or /model &lt;id&gt; for any {provider} model)</Text>
      </Text>
      <SelectList items={items} onSelect={onSelect} onCancel={onCancel} />
    </Box>
  );
}
