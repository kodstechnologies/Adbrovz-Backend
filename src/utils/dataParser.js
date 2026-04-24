/**
 * Robustly parses array-like inputs (strings, stringified JSON, arrays of objects)
 * into a flat array of cleaned strings or ObjectIDs.
 * 
 * @param {any} input - The input to parse
 * @returns {Array<string>} - A flat array of strings
 */
const parseArrayInput = (input) => {
    if (!input) return [];

    // 1. If it's already an array, we try to extract IDs from items
    if (Array.isArray(input)) {
        const parsed = input
            .map((item) => {
                if (!item) return null;
                if (typeof item === 'string') return item;
                if (typeof item === 'object') {
                    // Handle standard IDs and MongoDB $oid format
                    if (item._id) return String(item._id);
                    if (item.id) return String(item.id);
                    if (item.$oid) return String(item.$oid);
                    // If it's some other object, stringify it so regex can find the ID inside
                    return JSON.stringify(item);
                }
                return String(item);
            })
            .filter(Boolean)
            .flatMap((val) => {
                const str = String(val);
                // Try extracting 24-char hex IDs first
                const idMatches = str.match(/[a-fA-F0-9]{24}/g);
                if (idMatches && idMatches.length > 0) return idMatches;
                
                // Fallback for non-ID strings (like pincodes)
                return str.split(',').map(s => s.trim());
            });

        return [...new Set(parsed)].filter(s => s.length > 0);
    }

    // 2. If it's a string, it might be a stringified JSON or comma-separated values
    const str = String(input).trim();
    if (!str) return [];

    // Case A: Stringified JSON array or object
    if (str.startsWith('[') || str.startsWith('{')) {
        try {
            const json = JSON.parse(str);
            return parseArrayInput(json); // Recurse to handle the parsed JSON
        } catch (e) {
            // Not valid JSON, continue to regex/split
        }
    }

    // Case B: Extract IDs using regex (most robust for malformed strings)
    const idMatches = str.match(/[a-fA-F0-9]{24}/g);
    if (idMatches && idMatches.length > 0) {
        return [...new Set(idMatches)];
    }

    // Case C: Comma-separated values (like pincodes "560110, 560111")
    const cleaned = str.replace(/[\[\]\n\r'"+\s]/g, '');
    if (!cleaned) return [];

    return cleaned.split(',').filter(s => s.length > 0);
};

module.exports = {
    parseArrayInput
};
