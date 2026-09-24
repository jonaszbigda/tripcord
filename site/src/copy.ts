// <button data-copy="#snippet"> copies that element's text.
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  button.addEventListener("click", async () => {
    const target = document.querySelector(button.dataset.copy ?? "");
    await navigator.clipboard?.writeText(target?.textContent ?? "");
    button.textContent = "Copied";
  });
}
