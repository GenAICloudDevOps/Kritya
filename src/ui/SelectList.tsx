import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

export interface SelectItem {
  label: string;
  value: string;
  hint?: string;
}

export function SelectList({
  items,
  onSelect,
  onCancel,
}: {
  items: SelectItem[];
  onSelect(value: string): void;
  onCancel?(): void;
}) {
  const [rawIndex, setIndex] = useState(0);
  // Items can shrink under us (e.g. a live filter above the list).
  const index = items.length ? Math.min(rawIndex, items.length - 1) : 0;

  useInput((input, key) => {
    if (!items.length) {
      if (key.escape && onCancel) onCancel();
      return;
    }
    if (key.upArrow) setIndex((index - 1 + items.length) % items.length);
    else if (key.downArrow) setIndex((index + 1) % items.length);
    else if (key.return) onSelect(items[index].value);
    else if (key.escape && onCancel) onCancel();
  });

  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Text key={item.value} color={i === index ? "green" : undefined}>
          {i === index ? "❯ " : "  "}
          {item.label}
          {item.hint ? <Text dimColor> — {item.hint}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}
