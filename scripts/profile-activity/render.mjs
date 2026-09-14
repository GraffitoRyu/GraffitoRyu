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

function duration(minutes) {
  if (minutes === null) return 'Unavailable';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function renderProfile(activity) {
  const lowerBound = activity.aggregation === 'lower-bound';
  const count = (value) => `${lowerBound && value !== null ? '≥' : ''}${compactNumber(value)}`;
  const maximum = Math.max(1, ...activity.days.map((day) => day.tokens ?? 0));
  const cells = activity.days.map((day, index) => {
    const x = 25 + index * 21;
    if (day.tokens === null) return `<rect x="${x}" y="156" width="15" height="15" rx="3" fill="url(#unknown)"/><title>${escapeXml(day.date)}: unavailable</title>`;
    const opacity = day.tokens === 0 ? 0.12 : 0.28 + day.tokens / maximum * 0.72;
    return `<rect x="${x}" y="156" width="15" height="15" rx="3" fill="#2f81f7" opacity="${opacity.toFixed(2)}"/><title>${escapeXml(day.date)}: ${count(day.tokens)} tokens${day.coverage === 'complete' ? '' : ' (partial)'}</title>`;
  }).join('');
  const status = activity.status === 'unavailable' ? 'Coverage unavailable' : lowerBound ? 'Conservative lower bound · partial coverage' : activity.status === 'ready' ? 'Complete selected-log coverage' : 'Partial or delayed coverage';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="680" height="250" viewBox="0 0 680 250" role="img" aria-labelledby="title description">
<title id="title">Codex profile</title>
<desc id="description">Observed local Codex activity over the last 30 days. ${escapeXml(status)}.</desc>
<defs><pattern id="unknown" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#8c959f" opacity=".35"/></pattern><style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;fill:#1f2328}@media(prefers-color-scheme:dark){text{fill:#e6edf3}.panel{fill:#0d1117;stroke:#30363d}}</style></defs>
<rect class="panel" x=".5" y=".5" width="679" height="249" rx="10" fill="#fff" stroke="#d0d7de"/>
<text x="24" y="34" font-size="18" font-weight="600">Codex profile</text>
<text x="24" y="56" font-size="12" opacity=".72">Observed local Codex activity · last 30 days</text>
<text x="24" y="91" font-size="12" opacity=".72">30d tokens</text><text x="24" y="118" font-size="22" font-weight="600">${count(activity.summary.totalTokens)}</text>
<text x="190" y="91" font-size="12" opacity=".72">Max session</text><text x="190" y="118" font-size="22" font-weight="600">${compactNumber(activity.summary.maxSessionTokens)}</text>
<text x="355" y="91" font-size="12" opacity=".72">Longest chat</text><text x="355" y="118" font-size="22" font-weight="600">${duration(activity.summary.longestSessionMinutes)}</text>
<text x="520" y="91" font-size="12" opacity=".72">Current streak</text><text x="520" y="118" font-size="22" font-weight="600">${number(activity.summary.currentStreakDays)}${activity.summary.currentStreakDays === null ? '' : 'd'}</text>
${cells}
<text x="24" y="201" font-size="12" opacity=".72">Session-days</text><text x="24" y="224" font-size="18" font-weight="600">${count(activity.summary.sessionDays)}</text>
<text x="190" y="201" font-size="12" opacity=".72">Tool calls</text><text x="190" y="224" font-size="18" font-weight="600">${count(activity.summary.toolCalls)}</text>
<text x="355" y="201" font-size="12" opacity=".72">Longest streak</text><text x="355" y="224" font-size="18" font-weight="600">${number(activity.summary.longestStreakDays)}${activity.summary.longestStreakDays === null ? '' : 'd'}</text>
<text x="24" y="242" font-size="10" opacity=".62">${escapeXml(status)} · ${escapeXml(activity.window.from)} — ${escapeXml(activity.window.to)}</text>
</svg>
`;
}

export function renderActivitySvg(input) {
  const activity = parsePublicActivity(input);
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
