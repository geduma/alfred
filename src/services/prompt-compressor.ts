import { PromptCompressionConfig } from '../types/config';
import { getLogger } from '../utils/logger';

const ARTICLE_PATTERN = /\b(a|an|the)\s+/gi;
const AUXILIARY_PATTERN = /\b(is|are|was|were|been|being|have|has|had|do|does|did)\s+/gi;
const FILLER_PATTERN = /\b(actually|basically|literally|essentially|simply|just|really|very|quite|pretty|rather|truly|honestly|absolutely|certainly|definitely|obviously|undoubtedly)\s+/gi;

const PHRASE_MAP: [RegExp, string][] = [
  [/\bin order to\b/gi, 'to'],
  [/\ba lot of\b/gi, 'many'],
  [/\ba number of\b/gi, 'several'],
  [/\bthe majority of\b/gi, 'most'],
  [/\bin spite of\b/gi, 'despite'],
  [/\bbecause of the fact that\b/gi, 'because'],
  [/\bwith the exception of\b/gi, 'except'],
  [/\bin the event that\b/gi, 'if'],
  [/\bon the grounds that\b/gi, 'because'],
  [/\bwith regard to\b/gi, 'regarding'],
  [/\bin relation to\b/gi, 'about'],
  [/\bin respect of\b/gi, 'for'],
  [/\bwith reference to\b/gi, 'about'],
  [/\bit is important to note that\b/gi, 'note:'],
  [/\bit should be mentioned that\b/gi, 'note:'],
  [/\bwhat is the\b/gi, 'what'],
  [/\bthere is a\b/gi, 'there'],
  [/\bthere are\b/gi, 'there'],
  [/\bgoing to\b/gi, 'will'],
  [/\bwant to\b/gi, 'want'],
  [/\bneed to\b/gi, 'must'],
  [/\bhas to\b/gi, 'must'],
  [/\bhave to\b/gi, 'must'],
  [/\bis able to\b/gi, 'can'],
  [/\bare able to\b/gi, 'can'],
];

const SHORTEN_MAP: [RegExp, string][] = [
  [/\bapproximately\b/gi, '~'],
  [/\bregarding\b/gi, 're'],
  [/\bparagraph\b/gi, 'para'],
  [/\binformation\b/gi, 'info'],
  [/\bconfiguration\b/gi, 'config'],
  [/\bapplication\b/gi, 'app'],
  [/\bdocumentation\b/gi, 'docs'],
  [/\bdemonstrate\b/gi, 'show'],
  [/\binvestigate\b/gi, 'check'],
  [/\butilize\b/gi, 'use'],
  [/\butilization\b/gi, 'use'],
  [/\bimplement\b/gi, 'run'],
  [/\bimplementation\b/gi, 'setup'],
  [/\badditionally\b/gi, 'also'],
  [/\bfurthermore\b/gi, 'and'],
  [/\bnevertheless\b/gi, 'but'],
  [/\bconsequently\b/gi, 'so'],
  [/\bnotwithstanding\b/gi, 'despite'],
  [/\bsufficient\b/gi, 'enough'],
  [/\bsubsequently\b/gi, 'then'],
  [/\bpreviously\b/gi, 'before'],
  [/\bcurrently\b/gi, 'now'],
  [/\bspecifically\b/gi, 'mainly'],
  [/\bparticular\b/gi, 'main'],
  [/\bresponsible for\b/gi, 'handles'],
  [/\bcapable of\b/gi, 'can'],
  [/\bestablished\b/gi, 'set'],
  [/\benables\b/gi, 'lets'],
  [/\bfacilitates\b/gi, 'helps'],
  [/\bgenerate\b/gi, 'make'],
  [/\baccomplish\b/gi, 'do'],
  [/\bacquisition\b/gi, 'get'],
  [/\bterminate\b/gi, 'end'],
  [/\binitiate\b/gi, 'start'],
  [/\bnumerous\b/gi, 'many'],
  [/\bmultiple\b/gi, 'many'],
];

export class PromptCompressor {
  private config: PromptCompressionConfig;

  constructor(config?: Partial<PromptCompressionConfig>) {
    this.config = {
      enabled: true,
      mode: 'telegraph',
      aggressive: false,
      ...config,
    };
  }

  updateConfig(config: Partial<PromptCompressionConfig>): void {
    this.config = { ...this.config, ...config };
  }

  compress(text: string, configOverride?: PromptCompressionConfig): string {
    const cfg = configOverride || this.config;
    if (!cfg.enabled || cfg.mode === 'off') return text;
    if (!text || text.length < 50) return text;

    const originalLength = text.length;
    let result = text;

    result = this.compressPhrases(result);
    result = this.shortenWords(result);
    result = this.removeFillers(result);
    result = this.removeAuxiliaries(result);
    result = this.removeArticles(result);
    result = this.condenseWhitespace(result);

    if (cfg.aggressive) {
      result = this.aggressivePass(result);
    }

    const saved = Math.round((1 - result.length / originalLength) * 100);
    getLogger().debug({ savedPercent: saved, originalBytes: originalLength, compressedBytes: result.length }, 'Prompt compressed');

    return result;
  }

  private compressPhrases(text: string): string {
    for (const [pattern, replacement] of PHRASE_MAP) {
      text = text.replace(pattern, replacement);
    }
    return text;
  }

  private shortenWords(text: string): string {
    for (const [pattern, replacement] of SHORTEN_MAP) {
      text = text.replace(pattern, replacement);
    }
    return text;
  }

  private removeFillers(text: string): string {
    return text.replace(FILLER_PATTERN, '');
  }

  private removeAuxiliaries(text: string): string {
    return text.replace(AUXILIARY_PATTERN, '');
  }

  private removeArticles(text: string): string {
    return text.replace(ARTICLE_PATTERN, '');
  }

  private aggressivePass(text: string): string {
    text = text.replace(/\b(that|which|whom|whose)\b/gi, '');
    text = text.replace(/\b(will|shall)\b\s+be\b/gi, 'will');
    text = text.replace(/\b(could|would|should|might|may)\s+have\b/gi, '$1');
    text = text.replace(/\bthere is\b/gi, '');
    text = text.replace(/\bthere are\b/gi, '');
    text = text.replace(/\bit is\b/gi, '');
    text = text.replace(/\bit was\b/gi, '');
    return text;
  }

  private condenseWhitespace(text: string): string {
    return text.replace(/\s{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }
}
