import { Box, Text } from "ink";
import { CURATED_MODELS } from "../config/models.js";
import { SelectList, type SelectItem } from "./SelectList.js";

export function ModelPicker({
  current,
  customModels,
  onSelect,
  onCancel,
}: {
  current: string;
  customModels: { id: string; label?: string }[];
  onSelect(modelId: string): void;
  onCancel(): void;
}) {
  const items: SelectItem[] = [
    ...CURATED_MODELS.map((m) => ({
      label: m.label + (m.id === current ? " (current)" : ""),
      value: m.id,
      hint: m.note ? `${m.id} · ${m.note}` : m.id,
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
        <Text dimColor>(Esc to cancel, or /model &lt;id&gt; for any NVIDIA model)</Text>
      </Text>
      <SelectList items={items} onSelect={onSelect} onCancel={onCancel} />
    </Box>
  );
}
