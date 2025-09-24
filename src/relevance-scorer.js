/**
 * Simplified BM25 Relevance Scoring Module for SearchSync
 */
const BM25_CONFIG = {
  k1: 1.2,        // BM25 parameter for term frequency saturation
  b: 0.75,        // BM25 parameter for document length normalization
  recencyDecayPerDay: 0.01,
  minScore: 0.1
};

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'have',
  'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should'
]);

function tokenize(text) {
  if (!text || typeof text !== 'string') return [];

  // Simple tokenization
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(token => token.length > 1 && !STOP_WORDS.has(token));
}

function calculateBM25Score(queryTerms, docTokens, allDocTokens, avgDocLength) {
  const { k1, b } = BM25_CONFIG;
  const docLength = docTokens.length;
  if (docLength === 0) return 0;

  // Count term frequencies
  const termCounts = {};
  for (const token of docTokens) {
    termCounts[token] = (termCounts[token] || 0) + 1;
  }

  let score = 0;
  for (const term of queryTerms) {
    const tf = termCounts[term] || 0;
    if (tf > 0) {
      // Simple IDF calculation
      const docsWithTerm = allDocTokens.filter(tokens => tokens.includes(term)).length;
      if (docsWithTerm === 0) continue;

      const idf = Math.log((allDocTokens.length - docsWithTerm + 0.5) / (docsWithTerm + 0.5));
      const numerator = tf * (k1 + 1);
      const denominator = tf + k1 * (1 - b + b * (docLength / avgDocLength));
      score += idf * (numerator / denominator);
    }
  }
  return score;
}

function extractSearchableText(result) {
  // Combine all searchable text fields
  const text = [
    result.title || '',
    result.description || '',
    Array.isArray(result.tags) ? result.tags.join(' ') : (result.tags || ''),
    result.type || '',
    result.status || '',
    result.comments || ''
  ].join(' ');

  return tokenize(text);
}

function calculateRecencyBoost(updatedDate) {
  if (!updatedDate) return 0.5;

  try {
    const daysDiff = (new Date() - new Date(updatedDate)) / (1000 * 60 * 60 * 24);
    const boost = Math.exp(-daysDiff * BM25_CONFIG.recencyDecayPerDay);
    return Math.max(0.1, Math.min(1.0, boost));
  } catch {
    return 0.5;
  }
}

function calculateUserBoost(result, userContext = {}) {
  // Click history feature has been removed - always return neutral boost
  return 1.0;
}

function calculateRelevanceScores(results, query, userContext = {}) {
  if (!results || results.length === 0) return [];
  if (!query || typeof query !== 'string') return results;

  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return results;

  // Extract tokens from all results
  const docTokens = results.map(result => extractSearchableText(result));
  const avgDocLength = docTokens.reduce((sum, tokens) => sum + tokens.length, 0) / docTokens.length;

  // Calculate scores
  const scoredResults = results.map((result, index) => {
    const bm25Score = calculateBM25Score(queryTerms, docTokens[index], docTokens, avgDocLength);
    const recencyBoost = calculateRecencyBoost(result.updated);
    const userBoost = calculateUserBoost(result, userContext);

    const relevanceScore = bm25Score * recencyBoost * userBoost;

    return {
      ...result,
      relevanceScore: Math.max(BM25_CONFIG.minScore, relevanceScore)
    };
  });

  // Sort by relevance score
  return scoredResults.sort((a, b) => b.relevanceScore - a.relevanceScore);
}


module.exports = {
  calculateRelevanceScores
}; 