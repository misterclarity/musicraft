import { Button, Group, Modal, Stack, Text } from "@mantine/core";

/** Recognition of PDFs and photos (filled in with the recognition service). */
export function ScanImport({
  files,
  onClose,
}: {
  files: File[];
  onClose: () => void;
  onDone: (projectId: string) => void;
  onOpenSettings: () => void;
}) {
  return (
    <Modal opened onClose={onClose} title="Read sheet music">
      <Stack>
        <Text size="sm">
          {files.length} file{files.length > 1 ? "s" : ""} selected. Recognition of PDFs and photos is not available yet.
        </Text>
        <Group justify="flex-end">
          <Button onClick={onClose}>Close</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
