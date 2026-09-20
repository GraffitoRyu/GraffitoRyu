import { parsePublicActivity } from './contract.mjs';

function escapeXml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function number(value) {
  return value === null ? 'Unavailable' : value.toLocaleString('en-US');
}

function compactNumber(value) {
  return value === null ? 'Unavailable' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function compactExact(value, locale = 'en') {
  if (value === null) return 'Unavailable';
  const divisor = locale === 'ko' ? 1e8 : value >= 1e9 ? 1e9 : value >= 1e6 ? 1e6 : value >= 1e3 ? 1e3 : 1;
  const suffix = locale === 'ko' ? '억' : divisor === 1e9 ? 'B' : divisor === 1e6 ? 'M' : divisor === 1e3 ? 'K' : '';
  return `${(value / divisor).toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { maximumFractionDigits: 2 })}${suffix}`;
}

function compactLowerBound(value, locale = 'en') {
  if (value === null) return 'Unavailable';
  const units = locale === 'ko'
    ? [[1e12, '조'], [1e8, '억'], [1e4, '만']]
    : [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  const unit = units.find(([divisor]) => value >= divisor);
  if (!unit) return value.toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US');
  const scaled = Math.floor(value / unit[0] * 10) / 10;
  return `${scaled.toLocaleString(locale === 'ko' ? 'ko-KR' : 'en-US', { maximumFractionDigits: 1 })}${unit[1]}`;
}

function duration(minutes) {
  if (minutes === null) return 'Unavailable';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderSurface(activity, locale) {
  const ko = locale === 'ko';
  const type = ko
    ? { title: 22, subtitle: 14, label: 14, value: 27, section: 16, meta: 11, axis: 10, insight: 20, footer: 12 }
    : { title: 20, subtitle: 12, label: 12, value: 25, section: 14, meta: 10, axis: 9, insight: 18, footer: 10 };
  const evidence = activity.schemaVersion === 4;
  const copy = ko ? {
    title: evidence ? 'Codex 계정 활동' : 'Codex로 만든 30일', subtitle: evidence ? '공식 App Server 토큰 · 계정 Analytics' : '최근 30일 로컬 활동 관측', tokens: evidence ? '계정 누적 토큰' : '관측 토큰', sessions: evidence ? '계정 턴' : '관측 세션 시작', tools: evidence ? 'Plugin 호출' : '도구 호출', active: evidence ? '사용한 Skill' : '활동일', chart: evidence ? '일별 계정 토큰' : '일별 토큰 활동', insights: evidence ? '계정 토큰 인사이트' : '활동 인사이트', highestDay: evidence ? '최고 사용일' : '가장 높은 관측일', median: evidence ? '현재 / 최장 연속 활동' : '관측 일일 토큰 중앙값', footer: evidence ? '토큰은 Codex App Server 자동 수집 · Analytics 횟수는 계정 UI 확인' : '로컬 관측 · 익명 집계', outside: evidence ? '토큰 데이터 없음' : '토큰 관측 범위 밖', tokenDays: '토큰 일수', lowerBound: '+ 하한', tokenUnit: '토큰', description: evidence ? '공식 Codex App Server 토큰과 계정 Analytics 활동.' : '최근 30일의 익명 Codex 활동.',
  } : {
    title: evidence ? 'Codex account activity' : '30 days building with Codex', subtitle: evidence ? 'Official App Server tokens · account Analytics' : 'Observed local activity · last 30 days', tokens: evidence ? 'Account lifetime tokens' : 'Observed tokens', sessions: evidence ? 'Account turns' : 'Observed session starts', tools: evidence ? 'Plugin calls' : 'Tool calls', active: evidence ? 'Skills used' : 'Active days', chart: evidence ? 'Daily account tokens' : 'Daily token activity', insights: evidence ? 'Account token insights' : 'Activity insights', highestDay: evidence ? 'Peak account day' : 'Highest observed day', median: evidence ? 'Current / longest streak' : 'Median observed daily tokens', footer: evidence ? 'Tokens collected automatically via Codex App Server · Analytics counts verified in account UI' : 'Observed locally · anonymous aggregate', outside: evidence ? 'no token data' : 'outside token coverage', tokenDays: 'token days', lowerBound: '+ lower bound', tokenUnit: 'tokens', description: evidence ? 'Official Codex App Server token activity and account Analytics.' : 'Anonymous Codex activity over the last 30 days.',
  };
  const partial = activity.status === 'partial';
  const bounded = (value, formatter = number) => value === null ? '—' : `${formatter(value)}${partial ? '+' : ''}`;
  const tokenUsage = evidence ? activity.accountActivity.tokenUsage : null;
  const accountTokens = new Map(tokenUsage?.days.map((day) => [day.date, day.tokens]) ?? []);
  const chartDays = evidence ? activity.days.map((day) => ({ ...day, tokens: accountTokens.get(day.date) ?? null, coverage: accountTokens.has(day.date) ? 'complete' : 'unknown' })) : activity.days;
  const knownTokens = chartDays.flatMap((day) => day.tokens === null ? [] : [day.tokens]);
  const orderedTokens = [...knownTokens].sort((a, b) => a - b);
  const middle = Math.floor(orderedTokens.length / 2);
  const median = orderedTokens.length === 0 ? null : orderedTokens.length % 2 === 1 ? orderedTokens[middle] : Math.floor((orderedTokens[middle - 1] + orderedTokens[middle]) / 2);
  const observedMaximum = knownTokens.length === 0 ? null : Math.max(...knownTokens);
  const peakDay = observedMaximum === null ? null : chartDays.find((day) => day.tokens === observedMaximum) ?? null;
  const scaleMaximum = Math.max(1, observedMaximum ?? 0);
  const bars = chartDays.map((day, index) => {
    const x = 68 + index * 27;
    if (day.tokens === null) return `<rect class="token-bar token-unknown" x="${x}" y="318" width="15" height="8" rx="3" fill="none" stroke="#8c959f" stroke-dasharray="2 2" opacity=".7"><title>${escapeXml(day.date)}: ${copy.outside}</title></rect>`;
    const height = Math.max(day.tokens === 0 ? 2 : 5, Math.round(day.tokens / scaleMaximum * 128));
    const lowerBound = day.coverage !== 'complete';
    const tokenValue = evidence ? number(day.tokens) : lowerBound ? compactLowerBound(day.tokens, locale) : compactNumber(day.tokens);
    return `<rect class="token-bar" x="${x}" y="${326 - height}" width="15" height="${height}" rx="3" fill="#2f81f7"><title>${escapeXml(day.date)}: ${tokenValue}${lowerBound ? '+' : ''} ${copy.tokenUnit}</title></rect>`;
  }).join('');
  const ticks = [0, 7, 14, 21, 29].map((index) => `<text x="${75.5 + index * 27}" y="348" font-size="${type.axis}" text-anchor="middle" opacity=".62">${chartDays[index].date.slice(5)}</text>`).join('');
  const coverage = ko
    ? `${knownTokens.length} / ${chartDays.length}일 ${copy.tokenDays}${!evidence && partial ? ` · ${copy.lowerBound}` : ''}`
    : `${knownTokens.length} / ${chartDays.length} ${copy.tokenDays}${!evidence && partial ? ` · ${copy.lowerBound}` : ''}`;
  const compact = (value) => evidence ? compactExact(value, locale) : compactLowerBound(value, locale);
  const analytics = evidence ? activity.accountActivity.analytics : null;
  const firstValue = evidence ? compact(tokenUsage.summary.lifetimeTokens) : bounded(activity.summary.totalTokens, compact);
  const secondValue = evidence ? number(analytics.totals.turns) : bounded(activity.summary.newChats);
  const thirdValue = evidence ? number(analytics.totals.pluginCalls) : bounded(activity.summary.toolCalls);
  const fourthValue = evidence ? number(analytics.totals.skillUses) : activity.summary.activeDays === null ? '—' : `${number(activity.summary.activeDays)} / ${activity.days.length}`;
  const [firstLabel, secondLabel, thirdLabel, fourthLabel] = evidence ? [copy.tokens, copy.sessions, copy.tools, copy.active] : [copy.tokens, copy.sessions, copy.tools, copy.active];
  const leftInsight = peakDay === null ? '—' : evidence ? `${peakDay.date.slice(5)} · ${compact(peakDay.tokens)}` : peakDay.date.slice(5);
  const rightInsight = evidence ? `${number(tokenUsage.summary.currentStreakDays)}d / ${number(tokenUsage.summary.longestStreakDays)}d` : bounded(median, compact);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="590" viewBox="0 0 900 590" role="img" aria-labelledby="title description">
<title id="title">${copy.title}</title>
<desc id="description">${copy.description} ${escapeXml(coverage)}</desc>
<defs><style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;fill:#e6edf3}.grid,.divider{stroke:#30363d}.panel{fill:#0d1117;fill-opacity:.96;stroke:#30363d}@media(prefers-color-scheme:dark){.panel{fill-opacity:.24}}</style></defs>
<rect class="panel" x=".5" y=".5" width="899" height="589" rx="12" fill="#0d1117" fill-opacity=".96" stroke="#30363d"/>
<text x="32" y="38" font-size="${type.title}" font-weight="600">${copy.title}</text>
<text x="32" y="61" font-size="${type.subtitle}" opacity=".68">${copy.subtitle}</text>
<text x="32" y="94" font-size="${type.label}" opacity=".68">${firstLabel}</text><text x="32" y="124" font-size="${type.value}" font-weight="650">${firstValue}</text>
<line class="divider" x1="227" y1="84" x2="227" y2="132" opacity=".55"/>
<text x="249" y="94" font-size="${type.label}" opacity=".68">${secondLabel}</text><text x="249" y="124" font-size="${type.value}" font-weight="650">${secondValue}</text>
<line class="divider" x1="444" y1="84" x2="444" y2="132" opacity=".55"/>
<text x="466" y="94" font-size="${type.label}" opacity=".68">${thirdLabel}</text><text x="466" y="124" font-size="${type.value}" font-weight="650">${thirdValue}</text>
<line class="divider" x1="661" y1="84" x2="661" y2="132" opacity=".55"/>
<text x="683" y="94" font-size="${type.label}" opacity=".68">${fourthLabel}</text><text x="683" y="124" font-size="${type.value}" font-weight="650">${fourthValue}</text>
<text x="32" y="174" font-size="${type.section}" font-weight="600">${copy.chart}</text>
<text x="868" y="174" font-size="${type.meta}" text-anchor="end" opacity=".62">${escapeXml(activity.window.from)} — ${escapeXml(activity.window.to)} · ${escapeXml(coverage)}</text>
<line class="grid" x1="64" y1="198" x2="868" y2="198" opacity=".45"/><line class="grid" x1="64" y1="262" x2="868" y2="262" opacity=".28"/><line class="grid" x1="64" y1="326" x2="868" y2="326" opacity=".65"/>
<text x="32" y="202" font-size="${type.axis}" opacity=".58">${observedMaximum === null ? '—' : compact(observedMaximum)}</text><text x="32" y="330" font-size="${type.axis}" opacity=".58">0</text>
${bars}
${ticks}
<line class="divider" x1="32" y1="382" x2="868" y2="382" opacity=".55"/>
<text x="32" y="414" font-size="${type.section}" font-weight="600">${copy.insights}</text>
<text x="32" y="476" font-size="${type.label}" opacity=".68">${copy.highestDay}</text><text x="270" y="476" font-size="${type.insight}" font-weight="600">${leftInsight}</text>
<line class="divider" x1="450" y1="430" x2="450" y2="526" opacity=".55"/>
<text x="482" y="476" font-size="${type.label}" opacity=".68">${copy.median}</text><text x="700" y="476" font-size="${type.insight}" font-weight="600">${rightInsight}</text>
<text x="32" y="568" font-size="${type.footer}" opacity=".58">${copy.footer}</text>
</svg>
`;
}

function renderProfile(activity) {
  const lowerBound = activity.aggregation === 'lower-bound';
  const bounded = (value, formatter = compactNumber) => `${lowerBound && value !== null ? '≥' : ''}${formatter(value)}`;
  const maximum = Math.max(1, ...activity.days.map((day) => day.tokens ?? 0));
  const cells = activity.days.map((day, index) => {
    const x = 32 + index * 28;
    if (day.tokens === null) return `<rect x="${x}" y="177" width="20" height="20" rx="4" fill="url(#unknown)"/><title>${escapeXml(day.date)}: unavailable</title>`;
    const opacity = day.tokens === 0 ? 0.12 : 0.28 + day.tokens / maximum * 0.72;
    return `<rect x="${x}" y="177" width="20" height="20" rx="4" fill="#2f81f7" opacity="${opacity.toFixed(2)}"/><title>${escapeXml(day.date)}: ${bounded(day.tokens)} tokens${day.coverage === 'complete' ? '' : ' (partial)'}</title>`;
  }).join('');
  const status = activity.status === 'unavailable' ? 'Coverage unavailable' : lowerBound ? 'Conservative lower bound · partial coverage' : activity.status === 'ready' ? 'Complete selected-log coverage' : 'Partial or delayed coverage';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="350" viewBox="0 0 900 350" role="img" aria-labelledby="title description">
<title id="title">Codex profile</title>
<desc id="description">Observed local Codex activity over the last 30 days. ${escapeXml(status)}.</desc>
<defs><pattern id="unknown" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#8c959f" opacity=".35"/></pattern><style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;fill:#1f2328}@media(prefers-color-scheme:dark){text{fill:#e6edf3}.panel{fill:#0d1117;stroke:#30363d}}</style></defs>
<rect class="panel" x=".5" y=".5" width="899" height="349" rx="12" fill="#fff" stroke="#d0d7de"/>
<text x="32" y="35" font-size="19" font-weight="600">Codex profile</text>
<text x="32" y="57" font-size="12" opacity=".72">Observed local Codex activity · last 30 days</text>
<text x="32" y="93" font-size="12" opacity=".72">30d tokens</text><text x="32" y="122" font-size="23" font-weight="600">${bounded(activity.summary.totalTokens)}</text>
<text x="206" y="93" font-size="12" opacity=".72">Max session</text><text x="206" y="122" font-size="23" font-weight="600">${bounded(activity.summary.maxSessionTokens)}</text>
<text x="380" y="93" font-size="12" opacity=".72">Longest chat</text><text x="380" y="122" font-size="23" font-weight="600">${bounded(activity.summary.longestSessionMinutes, duration)}</text>
<text x="554" y="93" font-size="12" opacity=".72">Current streak</text><text x="554" y="122" font-size="23" font-weight="600">${bounded(activity.summary.currentStreakDays, number)}${activity.summary.currentStreakDays === null ? '' : 'd'}</text>
<text x="728" y="93" font-size="12" opacity=".72">Longest streak</text><text x="728" y="122" font-size="23" font-weight="600">${bounded(activity.summary.longestStreakDays, number)}${activity.summary.longestStreakDays === null ? '' : 'd'}</text>
<text x="32" y="160" font-size="14" font-weight="600">Token activity</text>
${cells}
<text x="32" y="240" font-size="14" font-weight="600">Activity insights</text>
<text x="32" y="270" font-size="12" opacity=".72">Active days</text><text x="32" y="300" font-size="22" font-weight="600">${bounded(activity.summary.activeDays)}</text>
<text x="320" y="270" font-size="12" opacity=".72">Session-days</text><text x="320" y="300" font-size="22" font-weight="600">${bounded(activity.summary.sessionDays)}</text>
<text x="608" y="270" font-size="12" opacity=".72">Tool calls</text><text x="608" y="300" font-size="22" font-weight="600">${bounded(activity.summary.toolCalls)}</text>
<text x="32" y="334" font-size="10" opacity=".62">${escapeXml(status)} · ${escapeXml(activity.window.from)} — ${escapeXml(activity.window.to)}</text>
</svg>
`;
}

export function renderActivitySvg(input, locale = 'en') {
  if (!['en', 'ko'].includes(locale)) throw new Error('unsupported locale');
  const activity = parsePublicActivity(input);
  if ([3, 4].includes(activity.schemaVersion)) return renderSurface(activity, locale);
  if (activity.schemaVersion === 2) return renderProfile(activity);
  const maximum = Math.max(1, ...activity.days.map((day) => day.toolCalls ?? 0));
  const bars = activity.days.map((day, index) => {
    const x = 30 + index * 20;
    if (day.toolCalls === null) return `<rect x="${x}" y="146" width="12" height="50" rx="2" fill="url(#unknown)"/><title>${escapeXml(day.date)}: unavailable</title>`;
    const height = Math.max(day.toolCalls === 0 ? 2 : 5, Math.round(day.toolCalls / maximum * 50));
    const opacity = day.coverage === 'complete' ? 1 : 0.55;
    return `<rect x="${x}" y="${196 - height}" width="12" height="${height}" rx="2" fill="#2f81f7" opacity="${opacity}"/><title>${escapeXml(day.date)}: ${day.toolCalls} tool calls${day.coverage === 'complete' ? '' : ' (partial)'}</title>`;
  }).join('');
  const status = activity.status === 'ready' ? 'Complete selected-log coverage' : activity.status === 'partial' ? 'Partial or delayed coverage' : 'Coverage unavailable';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="230" viewBox="0 0 680 230" role="img" aria-labelledby="title description">
<title id="title">AI-assisted development</title>
<desc id="description">Observed local Codex activity over the last 30 days. ${escapeXml(status)}.</desc>
<defs><pattern id="unknown" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#8c959f" opacity=".35"/></pattern><style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;fill:#1f2328}@media(prefers-color-scheme:dark){text{fill:#e6edf3}.panel{fill:#0d1117;stroke:#30363d}}</style></defs>
<rect class="panel" x=".5" y=".5" width="679" height="229" rx="10" fill="#fff" stroke="#d0d7de"/>
<text x="24" y="34" font-size="18" font-weight="600">AI-assisted development</text>
<text x="24" y="56" font-size="12" opacity=".72">Observed local Codex activity · last 30 days</text>
<text x="24" y="91" font-size="12" opacity=".72">Active days</text><text x="24" y="118" font-size="22" font-weight="600">${number(activity.summary.activeDays)}</text>
<text x="210" y="91" font-size="12" opacity=".72">Session-days</text><text x="210" y="118" font-size="22" font-weight="600">${number(activity.summary.sessionDays)}</text>
<text x="405" y="91" font-size="12" opacity=".72">Tool calls</text><text x="405" y="118" font-size="22" font-weight="600">${number(activity.summary.toolCalls)}</text>
${bars}
<text x="24" y="218" font-size="11" opacity=".68">${escapeXml(status)} · ${escapeXml(activity.window.from)} — ${escapeXml(activity.window.to)}</text>
</svg>
`;
}
