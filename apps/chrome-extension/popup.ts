/// <reference types="chrome" />
export {};
const connectionStatus = document.getElementById("status")!;
const form = document.getElementById("pair") as HTMLFormElement;
const input = document.getElementById("token") as HTMLInputElement;
const change = document.getElementById("change") as HTMLButtonElement;
const ready = document.getElementById("ready")!;
let editing = false;
let pairing = false;
let attempted = "";
async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: "status" });
  connectionStatus.textContent = result.message;
  form.hidden = result.connected && !editing;
  ready.hidden = !result.connected;
  change.hidden = !result.connected || editing;
}
async function pair() {
  const token = input.value.trim();
  if (pairing || !/^[a-f0-9]{64}$/.test(token)) return;
  pairing = true;
  attempted = token;
  try {
    const result = await chrome.runtime.sendMessage({ type: "pair", token });
    connectionStatus.textContent = result.message;
    editing = false;
    input.value = "";
    await refresh();
  } finally {
    pairing = false;
  }
}
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await pair();
});
input.addEventListener("input", () => {
  if (input.value.trim() !== attempted) void pair();
});
change.addEventListener("click", () => {
  editing = true;
  form.hidden = false;
  change.hidden = true;
  input.focus();
});
void refresh();
setInterval(() => void refresh(), 1000);
