import type { PiPgmPipelineSnapshot } from "./pipgm-model.js";

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderPiPgmStageHtml(pipeline: PiPgmPipelineSnapshot): string {
  const initialJson = JSON.stringify(pipeline).replace(/<\//g, "<\\/");
  const isPortrait = pipeline.orientation === "portrait";

  return `<!DOCTYPE html>
<html lang="fi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pipeline.label)} (${escapeHtml(pipeline.id)}) — PiPGM Stage</title>
  <style>
    :root {
      --stage-w: ${pipeline.resolution.width}px;
      --stage-h: ${pipeline.resolution.height}px;
      --fade-ms: ${pipeline.fadeDurationMs}ms;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: 100vw;
      height: 100vh;
      background: #000;
      color: #f8fafc;
      font-family: "Georgia", "Times New Roman", serif;
      overflow: hidden;
      user-select: none;
      cursor: none;
    }
    #stage-root {
      position: relative;
      width: 100vw;
      height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #05070d;
      overflow: hidden;
    }
    #stage-content {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: ${isPortrait ? "10vh 7vw" : "8vh 8vw"};
      text-align: center;
      position: relative;
    }
    /* Hymn Stanza Layout */
    .hymn-slide {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2.8vh;
      max-width: 92%;
      animation: fadeSlideIn 320ms ease-out;
    }
    .hymn-header {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: ${isPortrait ? "3.2vw" : "1.8vw"};
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: #fbbf24;
      font-weight: 700;
    }
    .hymn-stanza-lines {
      display: flex;
      flex-direction: column;
      gap: 1.4vh;
      font-size: ${isPortrait ? "5.2vw" : "3.3vw"};
      line-height: 1.38;
      color: #ffffff;
      text-shadow: 0 2px 12px rgba(0,0,0,0.85);
    }
    .hymn-footer {
      margin-top: 2vh;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: ${isPortrait ? "2.6vw" : "1.4vw"};
      color: #94a3b8;
      letter-spacing: 0.08em;
    }
    /* PowerPoint Slide + Step Animation Builds */
    .pptx-slide {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: flex-start;
      text-align: left;
      padding: 4vh 5vw;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .pptx-title {
      font-size: ${isPortrait ? "5.5vw" : "3.6vw"};
      font-weight: 700;
      color: #f8fafc;
      margin-bottom: 4vh;
      border-left: 6px solid #38bdf8;
      padding-left: 2vw;
    }
    .pptx-bullets {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 2.2vh;
      font-size: ${isPortrait ? "4.0vw" : "2.4vw"};
      color: #e2e8f0;
      padding-left: 2.4vw;
    }
    .pptx-bullet {
      opacity: 0;
      transform: translateY(16px);
      transition: opacity 380ms ease, transform 380ms ease;
    }
    .pptx-bullet.visible {
      opacity: 1;
      transform: translateY(0);
    }
    /* Media & Embeds */
    .stage-iframe, .stage-video, .stage-image {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
      background: #000;
    }
    .stage-image.contain, .stage-video { object-fit: contain; }
    .stage-image.cover { object-fit: cover; }

    /* Fade to Black Curtain */
    #ftb-curtain {
      position: fixed;
      inset: 0;
      background: #000000;
      z-index: 9999;
      pointer-events: none;
      opacity: ${pipeline.fadeToBlack ? "1" : "0"};
      transition: opacity var(--fade-ms) ease-in-out;
    }
    @keyframes fadeSlideIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>
  <div id="stage-root" data-pipeline="${escapeHtml(pipeline.id)}" data-orientation="${escapeHtml(pipeline.orientation)}">
    <div id="stage-content"></div>
    <div id="ftb-curtain" data-ftb="${pipeline.fadeToBlack ? "true" : "false"}"></div>
  </div>

  <script>
    let currentPipeline = ${initialJson};

    function escapeText(str) {
      const div = document.createElement("div");
      div.textContent = str ?? "";
      return div.innerHTML;
    }

    function renderStage(state) {
      currentPipeline = state;
      const root = document.getElementById("stage-root");
      const content = document.getElementById("stage-content");
      const curtain = document.getElementById("ftb-curtain");

      root.dataset.orientation = state.orientation;
      document.documentElement.style.setProperty("--fade-ms", (state.fadeDurationMs || 500) + "ms");
      curtain.style.opacity = state.fadeToBlack ? "1" : "0";
      curtain.dataset.ftb = state.fadeToBlack ? "true" : "false";

      const activeItem = state.playlist.find((i) => i.id === state.activeItemId) || null;
      if (!activeItem) {
        content.innerHTML = "";
        return;
      }

      const step = state.currentStepDetail || activeItem.steps[state.currentStep] || null;

      if (activeItem.kind === "hymn" && activeItem.hymn) {
        const lines = (step && step.previewText) ? step.previewText : [];
        content.innerHTML = \`
          <div class="hymn-slide">
            <div class="hymn-header">\${escapeText(activeItem.hymn.hymnNumber)} — \${escapeText(activeItem.hymn.title)}</div>
            <div class="hymn-stanza-lines">
              \${lines.map((line) => \`<div>\${escapeText(line)}</div>\`).join("")}
            </div>
            <div class="hymn-footer">\${escapeText(step ? step.label : "")}</div>
          </div>
        \`;
        return;
      }

      if (activeItem.kind === "pptx" && activeItem.pptx) {
        const slideNum = (step && step.slideNumber) || 1;
        const buildIdx = (step && step.buildIndex !== undefined) ? step.buildIndex : 0;
        const slide = activeItem.pptx.slides.find((s) => s.slideNumber === slideNum) || activeItem.pptx.slides[0];
        if (!slide) {
          content.innerHTML = "";
          return;
        }
        content.innerHTML = \`
          <div class="pptx-slide">
            <div class="pptx-title">\${escapeText(slide.title)}</div>
            <ul class="pptx-bullets">
              \${slide.bullets.map((b, idx) => \`
                <li class="pptx-bullet \${idx < buildIdx || slide.builds.length <= 1 ? "visible" : ""}">• \${escapeText(b)}</li>
              \`).join("")}
            </ul>
          </div>
        \`;
        return;
      }

      if (activeItem.kind === "canva" && activeItem.canva) {
        if (activeItem.canva.mode === "exported_mp4" && step && step.assetUrl) {
          content.innerHTML = \`
            <video class="stage-video" src="\${escapeText(step.assetUrl)}" autoplay \${state.audioEnabled ? "" : "muted"} playsinline></video>
          \`;
        } else if (activeItem.canva.mode === "exported_slides" && step && step.assetUrl) {
          content.innerHTML = \`
            <img class="stage-image contain" src="\${escapeText(step.assetUrl)}" alt="\${escapeText(activeItem.title)}" />
          \`;
        } else {
          content.innerHTML = \`
            <iframe class="stage-iframe" src="\${escapeText(activeItem.canva.embedUrl)}" allow="autoplay; fullscreen"></iframe>
          \`;
        }
        return;
      }

      if (activeItem.kind === "youtube" && activeItem.youtube) {
        const muteParam = state.audioEnabled ? "0" : "1";
        const autoplayParam = state.playbackState === "playing" ? "1" : "0";
        const startParam = activeItem.youtube.startSeconds || 0;
        const src = \`\${activeItem.youtube.embedUrl}?enablejsapi=1&autoplay=\${autoplayParam}&mute=\${muteParam}&start=\${startParam}&rel=0\`;
        content.innerHTML = \`
          <iframe class="stage-iframe" src="\${escapeText(src)}" allow="autoplay; encrypted-media; fullscreen"></iframe>
        \`;
        return;
      }

      if (activeItem.kind === "video" && activeItem.video) {
        content.innerHTML = \`
          <video id="active-video" class="stage-video" src="\${escapeText(activeItem.video.assetUrl)}" \${state.playbackState === "playing" ? "autoplay" : ""} \${activeItem.video.loop ? "loop" : ""} \${state.audioEnabled ? "" : "muted"} playsinline></video>
        \`;
        const vid = document.getElementById("active-video");
        if (vid) {
          vid.muted = !state.audioEnabled;
          vid.volume = Math.max(0, Math.min(1, (state.volume ?? 100) / 100));
        }
        return;
      }

      if (activeItem.kind === "image" && activeItem.image) {
        const fit = activeItem.image.fit || "contain";
        content.innerHTML = \`
          <img class="stage-image \${escapeText(fit)}" src="\${escapeText(activeItem.image.assetUrl)}" alt="\${escapeText(activeItem.title)}" />
        \`;
        return;
      }
    }

    renderStage(currentPipeline);

    // Listen for postMessage commands from Canva embed iframe or presenter window
    window.addEventListener("message", async (event) => {
      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (
        data.type === "pipgm:control" ||
        data.type === "canva:control" ||
        data.canvaAction ||
        data.pipgmAction
      ) {
        const action = data.action || data.canvaAction || data.pipgmAction;
        try {
          await fetch("/api/v1/pipgm/canva/control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              targetPipelineId: currentPipeline.id,
              action: action,
              pageNumber: data.pageNumber || data.page,
              stepIndex: data.stepIndex,
              fadeToBlack: data.fadeToBlack ?? data.ftb,
              ftbToggle: data.ftbToggle ?? data.toggleFtb,
              audioEnabled: data.audioEnabled,
              muteToggle: data.muteToggle ?? data.toggleMute,
              mode: data.mode
            })
          });
        } catch (err) {
          console.warn("Failed to forward postMessage control to PiPGM API:", err);
        }
      }
    });


    const sse = new EventSource("/api/v1/events");
    sse.addEventListener("pipgm", (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload && payload.pipeline && payload.pipeline.id === currentPipeline.id) {
          renderStage(payload.pipeline);
        }
      } catch {}
    });
  </script>
</body>
</html>`;
}
