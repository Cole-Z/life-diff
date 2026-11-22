export const copyTextScript = `<script>
document.addEventListener("click", async (event) => {
  if (!(event.target instanceof Element)) return;
  const button = event.target.closest("button[data-copy]");
  if (!button) return;
  const group = button.closest("[data-copy-group]");
  const field = group.querySelector("[data-copy-value]");
  const status = group.querySelector("[role=status]");
  try {
    if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(field.value);
    status.textContent = "Copied.";
  } catch {
    field.focus();
    field.select();
    status.textContent = "Selected. Use your device’s Copy command.";
  }
});
</script>`;
