import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useEffect, useState } from "react";
import { create } from "zustand";

type Dialog =
  | { kind: "confirm"; title: string; message: string; confirmLabel: string; danger: boolean; resolve: (ok: boolean) => void }
  | { kind: "prompt"; title: string; initial: string; label?: string; resolve: (value: string | null) => void };

const useDialog = create<{ dialog: Dialog | null }>(() => ({ dialog: null }));

/** Promise-based confirm and prompt dialogs (rendered by <DialogHost/>). */
export const modals = {
  confirm(title: string, message: string, options: { confirmLabel?: string; danger?: boolean } = {}): Promise<boolean> {
    return new Promise((resolve) =>
      useDialog.setState({
        dialog: {
          kind: "confirm",
          title,
          message,
          confirmLabel: options.confirmLabel ?? "Delete",
          danger: options.danger ?? true,
          resolve,
        },
      }),
    );
  },
  prompt(title: string, initial = "", label?: string): Promise<string | null> {
    return new Promise((resolve) => useDialog.setState({ dialog: { kind: "prompt", title, initial, label, resolve } }));
  },
};

export function DialogHost() {
  const dialog = useDialog((s) => s.dialog);
  const [value, setValue] = useState("");

  useEffect(() => {
    if (dialog?.kind === "prompt") setValue(dialog.initial);
  }, [dialog]);

  if (!dialog) return null;
  const close = () => {
    if (dialog.kind === "confirm") dialog.resolve(false);
    else dialog.resolve(null);
    useDialog.setState({ dialog: null });
  };
  const accept = () => {
    if (dialog.kind === "confirm") dialog.resolve(true);
    else dialog.resolve(value.trim() || null);
    useDialog.setState({ dialog: null });
  };

  return (
    <Modal opened onClose={close} title={dialog.title} centered>
      <Stack>
        {dialog.kind === "confirm" ? (
          <Text size="sm">{dialog.message}</Text>
        ) : (
          <TextInput
            label={dialog.label}
            value={value}
            onChange={(e) => setValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") accept();
            }}
            data-autofocus
          />
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={close}>
            Cancel
          </Button>
          <Button color={dialog.kind === "confirm" && dialog.danger ? "red" : undefined} onClick={accept}>
            {dialog.kind === "confirm" ? dialog.confirmLabel : "OK"}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
