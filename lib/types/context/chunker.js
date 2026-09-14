const DEFAULT_MAX = 4000;
const DEFAULT_MIN = 200;
const MAX_CHUNKS = 10_000;
function checkChunkCount(count) {
    if (count > MAX_CHUNKS)
        throw new RangeError('Context chunk limit exceeded (10000 per source)');
}
function validateOptions(options) {
    const max = options.maxChunkChars ?? DEFAULT_MAX;
    const min = options.minChunkChars ?? DEFAULT_MIN;
    if (!Number.isFinite(max) || !Number.isInteger(max) || max < 2)
        throw new RangeError('maxChunkChars must be a finite integer >= 2');
    if (!Number.isFinite(min) || !Number.isInteger(min) || min < 0 || min > max)
        throw new RangeError('minChunkChars must be a finite integer between 0 and maxChunkChars');
    return { maxChunkChars: max, minChunkChars: min };
}
function normalizedLines(text) {
    const result = [];
    let start = 0;
    while (start < text.length) {
        const nl = text.indexOf('\n', start);
        const end = nl < 0 ? text.length : nl + 1;
        result.push({ text: text.slice(start, end), start, end });
        start = end;
    }
    return result;
}
function headingInLine(line, fenced) {
    if (fenced)
        return undefined;
    const match = /^( {0,3})(#{1,6})(?:[ \t]+(.*?)\s*|[ \t]*)\r?\n?$/u.exec(line);
    if (!match)
        return undefined;
    let title = (match[3] ?? '').trim();
    title = title.replace(/[ \t]+#+[ \t]*$/u, '').trim();
    return { level: match[2].length, title };
}
function fenceOnLine(line, current) {
    const match = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (!match)
        return current;
    const token = match[1];
    const char = token[0];
    const length = token.length;
    if (current)
        return current.char === char && length >= current.length && line.slice(match[0].length).trim() === '' ? undefined : current;
    if (char === '`' && line.slice(match[0].length).includes('`'))
        return undefined;
    return { char, length };
}
function safePieces(text, max) {
    const pieces = [];
    let offset = 0;
    while (offset < text.length) {
        let end = Math.min(text.length, offset + max);
        const last = text.charCodeAt(end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff)
            end--;
        if (end === offset) { // max >= 2, so this only protects malformed future changes.
            end += Math.min(max, text.length - offset);
        }
        pieces.push(text.slice(offset, end));
        checkChunkCount(pieces.length);
        offset = end;
    }
    return pieces;
}
function splitSection(text, max) {
    if (text.length <= max)
        return [text];
    const lines = normalizedLines(text);
    const units = [];
    let unitStart = 0;
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.text.trim() === '' || i === lines.length - 1) {
            const end = line.end;
            units.push(text.slice(unitStart, end));
            unitStart = end;
        }
    }
    if (unitStart < text.length)
        units.push(text.slice(unitStart));
    const chunks = [];
    let current = '';
    for (const unit of units) {
        if (unit.length > max) {
            if (current) {
                chunks.push(current);
                current = '';
            }
            chunks.push(...safePieces(unit, max));
        }
        else if (current.length + unit.length <= max) {
            current += unit;
        }
        else {
            chunks.push(current);
            current = unit;
        }
    }
    if (current)
        chunks.push(current);
    return chunks;
}
export function chunkContext(source, options = {}) {
    const { maxChunkChars } = validateOptions(options);
    const content = source.content.replace(/\r\n?/gu, '\n');
    if (content.length === 0)
        return [];
    const lines = normalizedLines(content);
    const sections = [];
    let fenced;
    let currentStart = 0;
    let ancestry = [];
    let currentPath = [];
    let sawHeading = false;
    for (const line of lines) {
        const heading = headingInLine(line.text, fenced);
        if (heading) {
            if (line.start > currentStart)
                sections.push({ start: currentStart, end: line.start, headingPath: currentPath });
            checkChunkCount(sections.length);
            ancestry = ancestry.filter(parent => parent.level < heading.level);
            ancestry.push(heading);
            currentPath = ancestry.map(parent => parent.title);
            currentStart = line.start;
            sawHeading = true;
        }
        fenced = fenceOnLine(line.text, fenced);
    }
    if (currentStart < content.length || !sawHeading)
        sections.push({ start: currentStart, end: content.length, headingPath: currentPath });
    const chunks = [];
    let lineNumber = 1;
    const headingCounters = new Map();
    for (const section of sections) {
        const text = content.slice(section.start, section.end);
        if (!text)
            continue;
        const headingKey = JSON.stringify(section.headingPath);
        let currentHeadingOrdinal = headingCounters.get(headingKey) ?? 0;
        for (const piece of splitSection(text, maxChunkChars)) {
            const startLine = lineNumber;
            const newlines = piece.match(/\n/gu)?.length ?? 0;
            const endLine = startLine + newlines - (piece.endsWith('\n') ? 1 : 0);
            chunks.push({
                sourceId: source.sourceId,
                relativePath: source.relativePath,
                headingPath: section.headingPath,
                content: piece,
                startLine,
                endLine,
                partIndex: currentHeadingOrdinal++,
            });
            checkChunkCount(chunks.length);
            lineNumber += newlines;
        }
        headingCounters.set(headingKey, currentHeadingOrdinal);
    }
    return chunks;
}
//# sourceMappingURL=chunker.js.map