import { parsePublicActivity } from './contract.mjs';

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function number(value) {
  return value.toLocaleString('en-US');
}

function compact(value, locale) {
  const divisor = locale === 'ko' ? 1e8 : value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  const suffix = locale === 'ko' ? '억' : divisor === 1e9 ? 'B' : divisor === 1e6 ? 'M' : divisor === 1e3 ? 'K' : '';
  return `${(value / divisor).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { maximumFractionDigits: 2 })}${suffix}`;
}

function duration(seconds, locale) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return locale === 'ko' ? `${hours}시간 ${minutes}분` : `${hours}h ${minutes}m`;
}

export function renderActivitySvg(input, locale = 'en') {
  if (!['en', 'ko'].includes(locale)) throw new Error('unsupported locale');
  const activity = parsePublicActivity(input);
  const ko = locale === 'ko';
  const type = ko
    ? { title: 22, subtitle: 14, label: 14, value: 27, section: 16, meta: 11, axis: 10, footer: 12 }
    : { title: 20, subtitle: 12, label: 12, value: 25, section: 14, meta: 10, axis: 9, footer: 10 };
  const copy = ko ? {
    title: 'Codex 계정 활동', subtitle: '공식 Codex App Server 토큰 활동', tokens: '계정 누적 토큰', peak: '최대 일일 토큰', longestTurn: '최장 실행 시간', currentStreak: '현재 연속 기록', longestStreak: '최장 연속 기록', chart: '일별 계정 토큰', tokenDays: '토큰 일수', tokenUnit: '토큰', footer: 'Codex App Server에서 계정 토큰 자동 수집', description: '공식 Codex App Server 계정 토큰 활동.',
  } : {
    title: 'Codex account activity', subtitle: 'Official Codex App Server token activity', tokens: 'Account lifetime tokens', peak: 'Peak daily tokens', longestTurn: 'Longest running turn', currentStreak: 'Current streak', longestStreak: 'Longest streak', chart: 'Daily account tokens', tokenDays: 'token days', tokenUnit: 'tokens', footer: 'Account tokens collected automatically via Codex App Server', description: 'Official Codex App Server account token activity.',
  };
  const maximum = Math.max(...activity.days.map(({ tokens }) => tokens));
  const bars = activity.days.map((day, index) => {
    const height = Math.max(day.tokens === 0 ? 2 : 5, Math.round(day.tokens / Math.max(1, maximum) * 128));
    return `<rect class="token-bar" x="${68 + index * 27}" y="${326 - height}" width="15" height="${height}" rx="3"><title>${day.date}: ${number(day.tokens)} ${copy.tokenUnit}</title></rect>`;
  }).join('');
  const ticks = [0, 7, 14, 21, 29].map((index) => `<text x="${75.5 + index * 27}" y="348" font-size="${type.axis}" text-anchor="middle" opacity=".62">${activity.days[index].date.slice(5)}</text>`).join('');
  const coverage = ko ? `30 / 30일 ${copy.tokenDays}` : `30 / 30 ${copy.tokenDays}`;
  const summary = [
    [copy.tokens, compact(activity.summary.lifetimeTokens, locale)],
    [copy.peak, compact(activity.summary.peakDailyTokens, locale)],
    [copy.longestTurn, duration(activity.summary.longestRunningTurnSec, locale)],
    [copy.currentStreak, `${number(activity.summary.currentStreakDays)}d`],
    [copy.longestStreak, `${number(activity.summary.longestStreakDays)}d`],
  ].map(([label, value], index) => `${index === 0 ? '' : `<line class="divider" x1="${185 + (index - 1) * 170}" y1="84" x2="${185 + (index - 1) * 170}" y2="132" opacity=".55"/>`}<text x="${32 + index * 170}" y="94" font-size="${type.label}" opacity=".68">${label}</text><text x="${32 + index * 170}" y="124" font-size="${type.value}" font-weight="650">${value}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="410" viewBox="0 0 900 410" role="img" aria-labelledby="title description">
<title id="title">${copy.title}</title>
<desc id="description">${copy.description} ${escapeXml(coverage)}</desc>
<defs><style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;fill:#1f2328}.grid,.divider{stroke:#d0d7de}.panel{fill:#f6f8fa;fill-opacity:.02;stroke:#d0d7de}.token-bar{fill:#0969da;fill-opacity:.78}@media(prefers-color-scheme:dark){text{fill:#e6edf3}.grid,.divider{stroke:#30363d}.panel{fill:#161b22;fill-opacity:.36;stroke:#30363d}.token-bar{fill:#58a6ff;fill-opacity:.72}}</style></defs>
<rect class="panel" x=".5" y=".5" width="899" height="409" rx="12"/>
<text x="32" y="38" font-size="${type.title}" font-weight="600">${copy.title}</text>
<text x="32" y="61" font-size="${type.subtitle}" opacity=".68">${copy.subtitle}</text>
${summary}
<text x="32" y="174" font-size="${type.section}" font-weight="600">${copy.chart}</text>
<text x="868" y="174" font-size="${type.meta}" text-anchor="end" opacity=".62">${activity.window.from} — ${activity.window.to} · ${coverage}</text>
<line class="grid" x1="64" y1="198" x2="868" y2="198" opacity=".45"/><line class="grid" x1="64" y1="262" x2="868" y2="262" opacity=".28"/><line class="grid" x1="64" y1="326" x2="868" y2="326" opacity=".65"/>
<text x="32" y="202" font-size="${type.axis}" opacity=".58">${compact(maximum, locale)}</text><text x="32" y="330" font-size="${type.axis}" opacity=".58">0</text>
${bars}
${ticks}
<text x="32" y="392" font-size="${type.footer}" opacity=".58">${copy.footer}</text>
</svg>
`;
}
