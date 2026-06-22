const PAPER_SIZES = {
  A4: { width: 8.27, height: 11.69 },
  Letter: { width: 8.5, height: 11 },
  Legal: { width: 8.5, height: 14 }
};

const MARGINS = {
  default: 0.4,
  narrow: 0.2,
  none: 0
};

const CSS_PIXELS_PER_INCH = 96;
const MAX_SINGLE_PAGE_INCHES = 200;
const MIN_PRINT_SCALE = 0.1;
const MAX_PRINT_SCALE = 2;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "CREATE_PDF") return false;

  createPdf(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: formatError(error) }));

  return true;
});

async function createPdf(message) {
  const debuggee = { tabId: message.tabId };
  let attached = false;

  try {
    await attach(debuggee);
    attached = true;

    const media = message.options.media === "print" ? "print" : "screen";
    await sendCommand(debuggee, "Emulation.setEmulatedMedia", { media });

    const { pdfOptions, notice } = await buildPdfOptions(debuggee, message.options);
    const result = await sendCommand(debuggee, "Page.printToPDF", pdfOptions);

    if (!result?.data) {
      throw new Error("ChromeからPDFデータが返りませんでした。");
    }

    return {
      data: result.data,
      filename: buildFilename(message.title, message.url),
      notice
    };
  } finally {
    if (attached) {
      await detach(debuggee).catch(() => undefined);
    }
  }
}

async function buildPdfOptions(debuggee, options) {
  if (options.layoutMode === "single") {
    const singlePageOptions = await buildSinglePageOptions(debuggee, options);
    if (singlePageOptions) return singlePageOptions;
  }

  return {
    pdfOptions: buildPagedOptions(options),
    notice: options.layoutMode === "single"
      ? "ページが非常に長いため、ページ区切りのPDFとして保存しました。"
      : ""
  };
}

async function buildSinglePageOptions(debuggee, options) {
  const metrics = await sendCommand(debuggee, "Page.getLayoutMetrics");
  const contentSize = metrics.cssContentSize || metrics.contentSize;
  const contentWidth = Math.max(contentSize.width / CSS_PIXELS_PER_INCH, 1);
  const contentHeight = Math.max(contentSize.height / CSS_PIXELS_PER_INCH, 1);
  const requestedScale = clamp(Number(options.scale) || 1, MIN_PRINT_SCALE, MAX_PRINT_SCALE);
  const maxScaleForPage = Math.min(
    requestedScale,
    MAX_SINGLE_PAGE_INCHES / contentWidth,
    MAX_SINGLE_PAGE_INCHES / contentHeight
  );

  if (maxScaleForPage < MIN_PRINT_SCALE) {
    return null;
  }

  const scale = clamp(maxScaleForPage, MIN_PRINT_SCALE, requestedScale);
  const paperWidth = contentWidth * scale;
  const paperHeight = contentHeight * scale;
  const wasScaledDown = scale < requestedScale;

  return {
    pdfOptions: {
      landscape: false,
      displayHeaderFooter: Boolean(options.displayHeaderFooter),
      printBackground: Boolean(options.printBackground),
      scale,
      paperWidth,
      paperHeight,
      marginTop: options.displayHeaderFooter ? 0.35 : 0,
      marginBottom: options.displayHeaderFooter ? 0.35 : 0,
      marginLeft: 0,
      marginRight: 0,
      preferCSSPageSize: false,
      transferMode: "ReturnAsBase64"
    },
    notice: wasScaledDown
      ? `ページが長いため、${Math.round(scale * 100)}%に縮小して1ページに収めました。`
      : ""
  };
}

function buildPagedOptions(options) {
  const margin = MARGINS[options.margin] ?? MARGINS.default;
  const verticalMargin = options.displayHeaderFooter ? Math.max(margin, 0.35) : margin;
  const size = PAPER_SIZES[options.pageSize] ?? PAPER_SIZES.A4;
  const landscape = options.orientation === "landscape";
  return {
    landscape,
    displayHeaderFooter: Boolean(options.displayHeaderFooter),
    printBackground: Boolean(options.printBackground),
    scale: clamp(Number(options.scale) || 1, MIN_PRINT_SCALE, MAX_PRINT_SCALE),
    paperWidth: landscape ? size.height : size.width,
    paperHeight: landscape ? size.width : size.height,
    marginTop: verticalMargin,
    marginBottom: verticalMargin,
    marginLeft: margin,
    marginRight: margin,
    preferCSSPageSize: false,
    transferMode: "ReturnAsBase64"
  };
}

function attach(debuggee) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(debuggee, "1.3", () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(`ChromeのPDF機能に接続できませんでした: ${error.message}`));
      } else {
        resolve();
      }
    });
  });
}

function detach(debuggee) {
  return new Promise((resolve, reject) => {
    chrome.debugger.detach(debuggee, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function sendCommand(debuggee, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(`${method} failed: ${error.message}`));
      else resolve(result);
    });
  });
}

function buildFilename(title, url) {
  const date = new Date().toISOString().slice(0, 10);
  const rawTitle = title || url || "webpage";
  const safeTitle = rawTitle
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "webpage";
  return `Pagefolio PDF/${date}_${safeTitle}.pdf`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function formatError(error) {
  const message = error?.message || String(error);

  if (message.includes("Another debugger is already attached")) {
    return "このタブには別のデバッグ接続が使われています。DevToolsを閉じるか、ページを開き直してから試してください。";
  }

  if (message.includes("Cannot access")) {
    return "このページはChromeの制約でPDF化できません。通常のWebページで試してください。";
  }

  if (message.includes("No tab with id")) {
    return "対象のタブが見つかりません。ページを開いたまま、もう一度試してください。";
  }

  return message;
}
