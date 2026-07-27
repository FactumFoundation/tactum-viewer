// Build a TMS-style tile URL: `${baseUrl}${channel}/${level}/${col}/${row}.png`.
// baseUrl must end with a slash (e.g. '../moss/').
export function tileUrl(baseUrl, channel, node) {
  return `${baseUrl}${channel}/${node.level}/${node.col}/${node.row}.png`;
}
