import { inflateRawSync } from "node:zlib";
import type {
  PiPgmStepDescriptor,
  PptxAnimationBuild,
  PptxAnimationEffect,
  PptxItemData,
  PptxSlide
} from "./pipgm-model.js";

interface ZipEntry {
  name: string;
  content: Buffer;
}

/**
 * Lightweight native ZIP reader for .pptx OpenXML archives using Node's built-in zlib.
 */
export function extractZipXmlEntries(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;

  while (offset + 30 <= buffer.length) {
    const signature = buffer.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      break;
    }

    const compressionMethod = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const fileNameLength = buffer.readUInt16LE(offset + 26);
    const extraFieldLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + fileNameLength + extraFieldLength;

    if (dataStart + compressedSize > buffer.length) {
      break;
    }

    const name = buffer.subarray(nameStart, nameStart + fileNameLength).toString("utf8");
    const rawData = buffer.subarray(dataStart, dataStart + compressedSize);

    try {
      if (compressionMethod === 0) {
        entries.push({ name, content: rawData });
      } else if (compressionMethod === 8) {
        entries.push({ name, content: inflateRawSync(rawData) });
      }
    } catch {
      // Skip malformed entry
    }

    offset = dataStart + compressedSize;
  }

  return entries;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parseSlideXml(xml: string, slideNumber: number): PptxSlide {
  // Extract paragraphs (<a:p> ... </a:p>) and their text runs (<a:t>...</a:t>)
  const paragraphs: string[] = [];
  const pRegex = /<a:p\b[^>]*>([\s\S]*?)<\/a:p>/g;
  let pMatch: RegExpExecArray | null;

  while ((pMatch = pRegex.exec(xml)) !== null) {
    const pContent = pMatch[1] ?? "";
    const runs: string[] = [];
    const tRegex = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
    let tMatch: RegExpExecArray | null;
    while ((tMatch = tRegex.exec(pContent)) !== null) {
      runs.push(decodeXmlEntities(tMatch[1] ?? ""));
    }
    const line = runs.join("").trim();
    if (line.length > 0) {
      paragraphs.push(line);
    }
  }

  const title = paragraphs[0] ?? `Slide ${slideNumber}`;
  const bullets = paragraphs.slice(1);

  // Detect animation build steps inside <p:timing>
  const builds: PptxAnimationBuild[] = [
    {
      buildIndex: 0,
      effect: "initial",
      targetText: title,
      durationMs: 300
    }
  ];

  const timingMatch = /<p:timing\b[^>]*>([\s\S]*?)<\/p:timing>/.exec(xml);
  if (timingMatch && timingMatch[1]) {
    const timingXml = timingMatch[1];
    // Count click-triggered animation nodes or <p:animEffect> / <p:set>
    const effectMatches = [...timingXml.matchAll(/<p:animEffect\b(?:[^>]*?\bfilter="([^"]*)")?[^>]*>/g)];
    const clickMatches = [...timingXml.matchAll(/nodeType="clickEffect"/g)];
    const buildCount = Math.max(effectMatches.length, clickMatches.length);

    for (let i = 0; i < buildCount; i += 1) {
      const filterAttr = effectMatches[i]?.[1]?.toLowerCase() ?? "";
      let effect: PptxAnimationEffect = "appear";
      if (filterAttr.includes("fade")) effect = "fade";
      else if (filterAttr.includes("wipe")) effect = "wipe";
      else if (filterAttr.includes("fly")) effect = "fly";
      else if (filterAttr.includes("zoom")) effect = "zoom";

      builds.push({
        buildIndex: i + 1,
        effect,
        targetText: bullets[i] ?? `Animation Step ${i + 1}`,
        durationMs: 400
      });
    }
  } else if (bullets.length > 0) {
    // If no explicit <p:timing> was found, still include the initial slide state
    // (explicitly passed builds or bullets can be stepped if configured)
  }

  return {
    slideNumber,
    title,
    bullets,
    builds
  };
}

export interface PptxUploadInput {
  assetId: string;
  filename: string;
  buffer?: Buffer;
  slides?: Array<{
    slideNumber?: number;
    title: string;
    bullets?: string[];
    notes?: string;
    builds?: Array<{
      effect?: PptxAnimationEffect;
      targetText?: string;
      durationMs?: number;
    }>;
  }>;
  animateBulletsByDefault?: boolean;
}

export function parsePptxPresentation(input: PptxUploadInput): PptxItemData {
  // 1. If explicit slide definitions are provided alongside or instead of binary
  if (input.slides && input.slides.length > 0) {
    const slides: PptxSlide[] = input.slides.map((s, idx) => {
      const slideNumber = s.slideNumber ?? idx + 1;
      const bullets = s.bullets ?? [];
      let builds: PptxAnimationBuild[];

      if (s.builds && s.builds.length > 0) {
        builds = s.builds.map((b, bIdx) => ({
          buildIndex: bIdx,
          effect: b.effect ?? (bIdx === 0 ? "initial" : "appear"),
          ...(b.targetText ? { targetText: b.targetText } : {}),
          durationMs: b.durationMs ?? 350
        }));
      } else if (input.animateBulletsByDefault && bullets.length > 0) {
        builds = [
          { buildIndex: 0, effect: "initial", targetText: s.title, durationMs: 300 },
          ...bullets.map((bullet, bIdx) => ({
            buildIndex: bIdx + 1,
            effect: "fade" as const,
            targetText: bullet,
            durationMs: 350
          }))
        ];
      } else {
        builds = [{ buildIndex: 0, effect: "initial", targetText: s.title, durationMs: 300 }];
      }

      return {
        slideNumber,
        title: s.title,
        bullets,
        ...(s.notes ? { notes: s.notes } : {}),
        builds
      };
    });

    return {
      assetId: input.assetId,
      filename: input.filename,
      slideCount: slides.length,
      slides
    };
  }

  // 2. Try parsing OpenXML .pptx ZIP buffer if provided
  if (input.buffer && input.buffer.length > 0) {
    const entries = extractZipXmlEntries(input.buffer);
    const slideEntries = entries
      .filter((e) => /^ppt\/slides\/slide\d+\.xml$/i.test(e.name))
      .sort((a, b) => {
        const numA = Number(/slide(\d+)\.xml/i.exec(a.name)?.[1] ?? 0);
        const numB = Number(/slide(\d+)\.xml/i.exec(b.name)?.[1] ?? 0);
        return numA - numB;
      });

    if (slideEntries.length > 0) {
      const slides = slideEntries.map((entry, idx) => {
        const slideObj = parseSlideXml(entry.content.toString("utf8"), idx + 1);
        if (input.animateBulletsByDefault && slideObj.builds.length === 1 && slideObj.bullets.length > 0) {
          slideObj.bullets.forEach((bullet, bIdx) => {
            slideObj.builds.push({
              buildIndex: bIdx + 1,
              effect: "fade",
              targetText: bullet,
              durationMs: 350
            });
          });
        }
        return slideObj;
      });

      return {
        assetId: input.assetId,
        filename: input.filename,
        slideCount: slides.length,
        slides
      };
    }
  }

  // 3. Fallback default slide if an opaque binary was uploaded in simulation mode
  const fallbackSlide: PptxSlide = {
    slideNumber: 1,
    title: input.filename.replace(/\.pptx$/i, ""),
    bullets: [],
    builds: [{ buildIndex: 0, effect: "initial", targetText: input.filename, durationMs: 300 }]
  };

  return {
    assetId: input.assetId,
    filename: input.filename,
    slideCount: 1,
    slides: [fallbackSlide]
  };
}

export function buildPptxSteps(data: PptxItemData): PiPgmStepDescriptor[] {
  const rawSteps: Array<Omit<PiPgmStepDescriptor, "stepIndex" | "totalSteps">> = [];

  for (const slide of data.slides) {
    const builds = slide.builds.length > 0
      ? slide.builds
      : [{ buildIndex: 0, effect: "initial" as const, targetText: slide.title, durationMs: 300 }];

    builds.forEach((build, bIdx) => {
      const visibleBullets = slide.bullets.slice(0, bIdx);
      const stepLabel = builds.length > 1
        ? `Slide ${slide.slideNumber} (Anim ${bIdx + 1}/${builds.length})`
        : `Slide ${slide.slideNumber}`;

      rawSteps.push({
        label: stepLabel,
        subLabel: slide.title,
        slideNumber: slide.slideNumber,
        buildIndex: build.buildIndex,
        effect: build.effect,
        previewText: [slide.title, ...visibleBullets]
      });
    });
  }

  const totalSteps = rawSteps.length;
  return rawSteps.map((step, index) => ({
    ...step,
    stepIndex: index,
    totalSteps
  }));
}
