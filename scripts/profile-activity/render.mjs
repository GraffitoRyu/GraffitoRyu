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

function percent(value) {
  return value === null ? 'Unavailable' : `${value.toLocaleString('en-US')}%`;
}

function renderSurface(activity) {
  const maximum = Math.max(1, ...activity.days.map((day) => day.tokens ?? 0));
  const cells = activity.days.map((day, index) => {
    const x = 32 + index * 28;
    if (day.tokens === null) return `<rect x="${x}" y="177" width="20" height="20" rx="4" fill="url(#unknown)"/><title>${escapeXml(day.date)}: unavailable</title>`;
    const opacity = day.tokens === 0 ? 0.12 : 0.28 + day.tokens / maximum * 0.72;
    return `<rect x="${x}" y="177" width="20" height="20" rx="4" fill="#2f81f7" opacity="${opacity.toFixed(2)}"/><title>${escapeXml(day.date)}: ${compactNumber(day.tokens)} tokens</title>`;
  }).join('');
  const reasoning = activity.summary.reasoningPercent;
  const reasoningValues = reasoning === null ? 'Unavailable' : ['none', 'low', 'medium', 'high', 'xhigh', 'other'].map((key) => `${percent(reasoning[key])}`).join(' · ');
  const status = activity.status === 'ready' ? 'Complete selected-log coverage' : activity.status === 'partial' ? 'Partial or delayed coverage' : 'Coverage unavailable';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="520" viewBox="0 0 900 520" role="img" aria-labelledby="title description">
<title id="title">Codex activity silhouette</title>
<desc id="description">Anonymous Codex activity over the last 30 days. ${escapeXml(status)}.</desc>
<defs><pattern id="unknown" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="6" fill="#8c959f" opacity=".35"/></pattern><style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;fill:#1f2328}@media(prefers-color-scheme:dark){text{fill:#e6edf3}.panel{fill:#0d1117;stroke:#30363d}}</style></defs>
<rect class="panel" x=".5" y=".5" width="899" height="519" rx="12" fill="#fff" stroke="#d0d7de"/>
<text x="32" y="35" font-size="19" font-weight="600">Codex activity silhouette</text>
<text x="32" y="57" font-size="12" opacity=".72">Anonymous activity · last 30 days</text>
<text x="32" y="93" font-size="12" opacity=".72">30d tokens</text><text x="32" y="122" font-size="23" font-weight="600">${compactNumber(activity.summary.totalTokens)}</text>
<text x="206" y="93" font-size="12" opacity=".72">Max session</text><text x="206" y="122" font-size="23" font-weight="600">${compactNumber(activity.summary.maxSessionTokens)}</text>
<text x="380" y="93" font-size="12" opacity=".72">Longest chat</text><text x="380" y="122" font-size="23" font-weight="600">${duration(activity.summary.longestSessionMinutes)}</text>
<text x="554" y="93" font-size="12" opacity=".72">Current streak</text><text x="554" y="122" font-size="23" font-weight="600">${number(activity.summary.currentStreakDays)}${activity.summary.currentStreakDays === null ? '' : 'd'}</text>
<text x="728" y="93" font-size="12" opacity=".72">Longest streak</text><text x="728" y="122" font-size="23" font-weight="600">${number(activity.summary.longestStreakDays)}${activity.summary.longestStreakDays === null ? '' : 'd'}</text>
<text x="32" y="160" font-size="14" font-weight="600">Token activity</text>
${cells}
<text x="32" y="240" font-size="14" font-weight="600">Anonymous counters</text>
<text x="32" y="270" font-size="12" opacity=".72">Active days</text><text x="32" y="296" font-size="20" font-weight="600">${number(activity.summary.activeDays)}</text>
<text x="176" y="270" font-size="12" opacity=".72">Session-days</text><text x="176" y="296" font-size="20" font-weight="600">${number(activity.summary.sessionDays)}</text>
<text x="320" y="270" font-size="12" opacity=".72">New chats</text><text x="320" y="296" font-size="20" font-weight="600">${number(activity.summary.newChats)}</text>
<text x="464" y="270" font-size="12" opacity=".72">Tool calls</text><text x="464" y="296" font-size="20" font-weight="600">${number(activity.summary.toolCalls)}</text>
<text x="608" y="270" font-size="12" opacity=".72">Plugin calls</text><text x="608" y="296" font-size="20" font-weight="600">${number(activity.summary.pluginCalls)}</text>
<text x="752" y="270" font-size="12" opacity=".72">Skill uses</text><text x="752" y="296" font-size="20" font-weight="600">${number(activity.summary.skillUses)}</text>
<text x="32" y="334" font-size="12" opacity=".72">Browser/web</text><text x="32" y="360" font-size="20" font-weight="600">${number(activity.summary.browserCalls)}</text>
<text x="248" y="334" font-size="12" opacity=".72">Computer use</text><text x="248" y="360" font-size="20" font-weight="600">${number(activity.summary.computerUseCalls)}</text>
<text x="464" y="334" font-size="12" opacity=".72">Other tools</text><text x="464" y="360" font-size="20" font-weight="600">${number(activity.summary.otherToolCalls)}</text>
<text x="680" y="334" font-size="12" opacity=".72">Fast mode</text><text x="680" y="360" font-size="20" font-weight="600">${percent(activity.summary.fastModePercent)}</text>
<text x="32" y="405" font-size="14" font-weight="600">Reasoning</text>
<text x="32" y="430" font-size="11" opacity=".72">none · low · medium · high · xhigh · other</text>
<text x="32" y="456" font-size="13">${reasoningValues}</text>
<text x="32" y="498" font-size="10" opacity=".62">${escapeXml(status)} · ${escapeXml(activity.window.from)} — ${escapeXml(activity.window.to)}</text>
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

export function renderActivitySvg(input) {
  const activity = parsePublicActivity(input);
  if (activity.schemaVersion === 3) return renderSurface(activity);
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
