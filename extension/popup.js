const fields = {
  layoutMode: document.getElementById("layoutMode"),
  pageSize: document.getElementById("pageSize"),
  orientation: document.getElementById("orientation"),
  margin: document.getElementById("margin"),
  media: document.getElementById("media"),
  printBackground: document.getElementById("printBackground"),
  displayHeaderFooter: document.getElementById("displayHeaderFooter"),
  chooseLocation: document.getElementById("chooseLocation"),
  scale: document.getElementById("scale")
};

const saveButton = document.getElementById("saveButton");
const statusEl = document.getElementById("status");
const tabTitleEl = document.getElementById("tabTitle");
const scaleValueEl = document.getElementById("scaleValue");

let currentTab = null;

init();

async function init() {
  const saved = await chrome.storage.local.get(["pdfOptions"]);
  if (saved.pdfOptions) {
    applyOptions(saved.pdfOptions);
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;
  tabTitleEl.textContent = tab?.title || "現在のタブをPDFに保存";
  validateCurrentTab();
  updateScaleLabel();
}

fields.scale.addEventListener("input", updateScaleLabel);
saveButton.addEventListener("click", savePdf);

async function savePdf() {
  if (!currentTab?.id) {
    setStatus("現在のタブを取得できませんでした。", true);
    return;
  }

  const options = readOptions();
  await chrome.storage.local.set({ pdfOptions: options });

  saveButton.disabled = true;
  setStatus("PDFを作成しています。ページが長い場合は少し時間がかかります。");

  try {
    const result = await chrome.runtime.sendMessage({
      type: "CREATE_PDF",
      tabId: currentTab.id,
      title: currentTab.title || "webpage",
      url: currentTab.url || "",
      options
    });

    if (!result?.ok) {
      throw new Error(result?.error || "PDFを作成できませんでした。");
    }

    const blob = base64ToBlob(result.data, "application/pdf");
    const blobUrl = URL.createObjectURL(blob);
    await chrome.downloads.download({
      url: blobUrl,
      filename: result.filename,
      saveAs: options.chooseLocation
    });
    setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
    setStatus(result.notice || "保存ダイアログを開きました。", false, true);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    saveButton.disabled = false;
  }
}

function readOptions() {
  return {
    layoutMode: fields.layoutMode.value,
    pageSize: fields.pageSize.value,
    orientation: fields.orientation.value,
    margin: fields.margin.value,
    media: fields.media.value,
    printBackground: fields.printBackground.checked,
    displayHeaderFooter: fields.displayHeaderFooter.checked,
    chooseLocation: fields.chooseLocation.checked,
    scale: Number(fields.scale.value) / 100
  };
}

function applyOptions(options) {
  for (const [key, value] of Object.entries(options)) {
    if (!fields[key]) continue;
    if (fields[key].type === "checkbox") {
      fields[key].checked = Boolean(value);
    } else if (key === "scale") {
      fields[key].value = String(Math.round(Number(value) * 100));
    } else {
      fields[key].value = value;
    }
  }
}

function updateScaleLabel() {
  scaleValueEl.textContent = `${fields.scale.value}%`;
}

function validateCurrentTab() {
  const url = currentTab?.url || "";
  const blocked = [
    "chrome://",
    "chrome-extension://",
    "edge://",
    "about:"
  ].some((prefix) => url.startsWith(prefix));

  const chromeStore = url.startsWith("https://chromewebstore.google.com/");

  if (blocked || chromeStore) {
    saveButton.disabled = true;
    setStatus("このページはChromeの制約でPDF化できません。通常のWebページで試してください。", true);
  }
}

function setStatus(message, isError = false, isSuccess = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
  statusEl.classList.toggle("success", isSuccess);
}

function base64ToBlob(base64, mimeType) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}
