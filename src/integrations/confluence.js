/**
 * Confluence integration for SearchSync
 *
 * This module provides functionality to search Confluence spaces and pages
 * using the Atlassian REST API.
 */

const axios = require('axios');
const Logger = require('../utils/logger');
const { createAuthError, createValidationError, wrapUnknownError } = require('../utils/integration-errors');
const { generateCorrelationId, validateRequiredFields } = require('./utils');

// Create logger instance
const logger = new Logger({
  component: 'ConfluenceIntegration'
});

/**
 * Safely escapes CQL values for quoted literals
 * Escapes all CQL special characters to prevent injection
 * @param {string} input - Input string to escape
 * @returns {string} - Escaped string safe for CQL quotes
 */
function escapeCQLValue(input) {
  if (!input || typeof input !== 'string') return '';

  // Escape all CQL special characters inside quoted strings
  return input
    .replace(/\\/g, '\\\\')    // Backslash first
    .replace(/"/g, '\\"')      // Double quotes
    .replace(/'/g, "\\'")      // Single quotes
    .replace(/\{/g, '\\{')     // Curly braces
    .replace(/\}/g, '\\}')
    .replace(/\[/g, '\\[')     // Square brackets
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')     // Parentheses
    .replace(/\)/g, '\\)')
    .replace(/\./g, '\\.')     // Dot (for property access)
    .replace(/:/g, '\\:')     // Colon (for namespaces)
    .replace(/;/g, '\\;')     // Semicolon
    .replace(/=/g, '\\=')     // Equals sign
    .replace(/-/g, '\\-')     // Hyphen
    .replace(/\+/g, '\\+');   // Plus sign
}

/**
 * Validates Confluence space key format
 * @param {string} spaceKey - Space key to validate
 * @returns {boolean} - True if valid
 */
function validateSpaceKey(spaceKey) {
  if (!spaceKey || typeof spaceKey !== 'string') return false;
  // Confluence space keys are typically uppercase alphanumeric
  return /^[A-Z0-9]+$/.test(spaceKey);
}

/**
 * Builds CQL query with proper escaping and validation
 * @param {string} query - Search query
 * @param {Object} filters - Additional filters
 * @returns {string} - Valid CQL query
 */
function buildCQL(query, filters = {}) {
  const cqlParts = [];

  // Allowlist of safe CQL operators for advanced queries
  const SAFE_OPERATORS = new Set(['AND', 'OR', 'NOT', 'IN', '~', '=', '!=', '>', '<', '>=', '<=']);
  const MAX_QUERY_LENGTH = 1000;
  const MAX_CLAUSES = 10;

  // Handle text search with strict validation
  if (query && query.trim()) {
    const trimmedQuery = query.trim();

    // Check query length
    if (trimmedQuery.length > MAX_QUERY_LENGTH) {
      logger.warn('Query too long, truncating', {
        originalLength: trimmedQuery.length,
        maxLength: MAX_QUERY_LENGTH
      });
      query = trimmedQuery.substring(0, MAX_QUERY_LENGTH);
    }

    // Check if this looks like an advanced CQL query
    const hasAdvancedOperators = /\s+(AND|OR|NOT|IN)\s+|[=~<>!]=?/.test(trimmedQuery);

    if (hasAdvancedOperators) {
      // Validate advanced query more strictly
      const tokens = trimmedQuery.split(/\s+/);
      let clauseCount = 0;

      // Check each part of the query
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i].toUpperCase();

        // Count logical operators (indicates clauses)
        if (SAFE_OPERATORS.has(token) && ['AND', 'OR', 'NOT'].includes(token)) {
          clauseCount++;
        }

        // Reject potentially dangerous characters
        if (/[';\[\]{}]/.test(tokens[i]) && !/^["'].*["']$/.test(tokens[i])) {
          logger.warn('Potentially unsafe characters in query, using safe search', {
            query: trimmedQuery,
            unsafeToken: tokens[i]
          });
          // Fall back to safe text search
          cqlParts.push(`text ~ "${escapeCQLValue(trimmedQuery)}"`);
          break;
        }
      }

      // If we didn't fall back to safe search and clause count is reasonable
      if (cqlParts.length === 0 && clauseCount <= MAX_CLAUSES) {
        cqlParts.push(trimmedQuery);
      } else if (cqlParts.length === 0) {
        // Too many clauses, fall back to safe search
        logger.warn('Too many clauses in query, using safe search', { clauseCount, maxClauses: MAX_CLAUSES });
        cqlParts.push(`text ~ "${escapeCQLValue(trimmedQuery)}"`);
      }
    } else {
      // Simple text search - always safe
      cqlParts.push(`text ~ "${escapeCQLValue(trimmedQuery)}"`);
    }
  } else {
    cqlParts.push('type = "page"');
  }

  // Add space filter if provided
  if (filters.space) {
    if (validateSpaceKey(filters.space)) {
      cqlParts.push(`space = "${filters.space}"`);
    } else {
      logger.warn('Invalid space key format, ignoring space filter', {
        space: filters.space
      });
    }
  }

  // Add content type filter if specified
  if (filters.type) {
    // Validate content type against allowlist
    const safeTypes = new Set(['page', 'blogpost', 'attachment', 'comment']);
    if (safeTypes.has(filters.type.toLowerCase())) {
      cqlParts.push(`type = "${filters.type}"`);
    } else {
      logger.warn('Invalid content type, ignoring type filter', {
        type: filters.type
      });
    }
  }

  // Combine with AND and add ordering
  const finalCQL = cqlParts.join(' AND ') + ' ORDER BY lastmodified DESC';

  logger.debug('Built CQL query', {
    cql: finalCQL,
    queryLength: finalCQL.length,
    correlationId: generateCorrelationId()
  });

  return finalCQL;
}

/**
 * Search Confluence for content matching the query
 *
 * @param {string} query - Search query string
 * @param {object} config - Confluence configuration
 * @param {string} config.baseUrl - Confluence base URL (e.g., https://your-domain.atlassian.net)
 * @param {string} config.email - User email for authentication
 * @param {string} config.apiToken - API token for authentication
 * @param {string} [config.space] - Optional space key to limit search to a specific space
 * @returns {Promise<Array>} - Array of search results in standardized format
 */
async function searchConfluence(query, config) {
  const correlationId = generateCorrelationId();

  try {
    // Validate required fields
    const validationError = validateRequiredFields(config, ['baseUrl', 'apiToken']);
    if (validationError) {
      throw createValidationError('confluence', 'config', validationError);
    }

    // Use URL normalization helper
    const { normalizeBaseUrl } = require('./utils');
    const baseUrl = normalizeBaseUrl(config.baseUrl);

    // Get the email from config or use a fallback
    const email = config.email || process.env.CONFLUENCE_EMAIL || 'your-email@example.com';

    // Create Basic auth token from email and API token
    const token = Buffer.from(`${email}:${config.apiToken}`).toString('base64');

    // Build CQL with proper escaping
    const filters = {};
    if (config.space) {
      if (validateSpaceKey(config.space)) {
        filters.space = config.space;
      } else {
        logger.warn('Invalid space key format, ignoring space filter', {
          space: config.space,
          correlationId
        });
      }
    }

    const cql = buildCQL(query, filters);

    logger.debug('Searching Confluence', {
      query,
      cql,
      space: filters.space,
      correlationId
    });

    // Make the API request to Confluence
    const response = await axios.get(`${baseUrl}/wiki/rest/api/content/search`, {
      headers: {
        'Authorization': `Basic ${token}`,
        'Accept': 'application/json'
      },
      params: {
        cql,
        limit: Math.min(config.limit || 25, 100), // Cap at 100
        expand: 'body.view,body.storage,space,history.lastUpdated,history.createdBy,version.by,ancestors,restrictions.read.restrictions.user'
      },
      timeout: 10000
    });

    // Process and return the results
    const keywords = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
    return processResults(response.data, baseUrl, keywords);

  } catch (error) {
    logger.error('Confluence search failed', {
      error: error.message,
      correlationId
    });

    // Handle specific error cases
    if (error.response) {
      switch (error.response.status) {
        case 400:
          // Try with a basic query as fallback
          try {
            logger.info('Attempting fallback search', { correlationId });
            const fallbackCql = 'type = "page" ORDER BY lastmodified DESC';

            const fallbackResponse = await axios.get(`${baseUrl}/wiki/rest/api/content/search`, {
              headers: {
                'Authorization': `Basic ${token}`,
                'Accept': 'application/json'
              },
              params: {
                cql: fallbackCql,
                limit: 25,
                expand: 'body.view,space,history.lastUpdated'
              },
              timeout: 10000
            });

            const keywords = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
            return processResults(fallbackResponse.data, baseUrl, keywords);
          } catch (fallbackError) {
            logger.error('Fallback search also failed', {
              error: fallbackError.message,
              correlationId
            });
            throw createAuthError('confluence', 'Search failed after fallback', fallbackError);
          }

        case 401:
        case 403:
          throw createAuthError('confluence', 'Authentication failed', error);

        case 404:
          throw createValidationError('confluence', 'url', 'Confluence instance not found');

        case 429:
          const retryAfter = error.response.headers['retry-after'];
          throw new Error(`Rate limit exceeded${retryAfter ? `. Retry after ${retryAfter}s` : ''}`);

        default:
          throw wrapUnknownError('confluence', error);
      }
    }

    // Handle network errors
    if (error.code === 'ECONNABORTED') {
      throw new Error('Request timeout. Please try again.');
    } else if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
      throw new Error('Network error: Unable to connect to Confluence.');
    }

    throw wrapUnknownError('confluence', error);
  }
}

/**
 * Process Confluence search results into a standardized format
 * @param {object} data - Raw response data from Confluence API
 * @param {string} baseUrl - Confluence base URL
 * @param {Array} keywords - Keywords extracted from the query
 * @returns {Array} - Standardized search results
 */
function processResults(data, baseUrl, keywords = []) {
  if (!data || !data.results) {
    return [];
  }

  // Transform API results to our standardized format
  const transformedResults = data.results
    .map(item => {
      // Extract basic metadata
      const id = item.id;
      const title = item.title || 'Untitled';
      const type = item.type || 'page';
      const status = item.status || 'current';
      const spaceName = item.space ? item.space.name : 'Unknown Space';
      const spaceKey = item.space ? item.space.key : '';
      const updated = item.history && item.history.lastUpdated ? item.history.lastUpdated.when : null;

      // Extract text content from HTML body
      let description = '';
      if (item.body && item.body.view && item.body.view.value) {
        description = extractTextFromHtml(item.body.view.value);
        
        // Limit description length
        if (description.length > 200) {
          description = description.substring(0, 197) + '...';
        }
      }

      // Extract additional metadata
      const version = item.version?.number || 1;
      const lastModifierName = item.version?.by?.displayName || 'Unknown';
      const restrictions = item.restrictions?.read?.restrictions?.user?.results || [];
      const isRestricted = restrictions.length > 0;
      
      // Calculate activity metrics
      const daysSinceUpdate = updated ? 
        Math.floor((new Date() - new Date(updated)) / (1000 * 60 * 60 * 24)) : null;
      
      // Extract parent page if available
      const parentPage = item.ancestors && item.ancestors.length > 0 ? 
        item.ancestors[item.ancestors.length - 1] : null;
      
      // Count content indicators
      const wordCount = description ? description.split(/\s+/).length : 0;
      const hasImages = item.body?.storage?.value ? 
        (item.body.storage.value.match(/<ac:image|<img/g) || []).length > 0 : false;
      const hasMacros = item.body?.storage?.value ? 
        (item.body.storage.value.match(/<ac:/g) || []).length > 0 : false;
      
      // Return standardized result format with enhanced metadata
      return {
        id: item.id,
        title: item.title || 'Untitled',
        description: description || 'No description available',
        url: `${baseUrl}${item._links.webui.replace('/spaces', '/wiki/spaces')}`,
        source: 'Confluence',
        type: item.type || 'Page',
        status: item.status || 'current',
        updated: updated || new Date().toISOString(),
        space: spaceName,
        metadata: {
          // Basic info
          type: item.type || 'Page',
          status: item.status || 'current',
          version: version,
          
          // Space and hierarchy
          space: spaceName,
          spaceKey: item.space?.key || 'Unknown',
          parentPage: parentPage ? parentPage.title : null,
          parentPageId: parentPage ? parentPage.id : null,
          
          // People
          lastModifier: lastModifierName,
          creator: item.history?.createdBy?.displayName || 'Unknown',
          
          // Access control
          isRestricted: isRestricted,
          restrictedToUsers: restrictions.map(user => user.displayName),
          
          // Content metrics
          wordCount: wordCount,
          hasImages: hasImages,
          hasMacros: hasMacros,
          
          // Activity metrics
          daysSinceUpdate: daysSinceUpdate,
          
          // Dates
          createdDate: item.history?.createdDate || null,
          updatedDate: updated
        },
        
        // Add activity indicators
        activityIndicators: {
          hasRecentActivity: daysSinceUpdate !== null && daysSinceUpdate <= 7,
          isNewContent: daysSinceUpdate !== null && daysSinceUpdate <= 1,
          hasRichContent: hasImages || hasMacros,
          isLongForm: wordCount > 500,
          isRestricted: isRestricted
        }
      };
    })
    .filter(item => {
      // Client-side filtering to improve results
      // If no keywords, return all results
      if (!keywords || keywords.length === 0) return true;

      // Otherwise, check if title or description contains any keyword
      const titleLower = item.title.toLowerCase();
      const descriptionLower = item.description.toLowerCase();

      return keywords.some(keyword =>
        titleLower.includes(keyword) || descriptionLower.includes(keyword)
      );
    });

    return transformedResults;
}

/**
 * Extract plain text from HTML string
 *
 * @param {string} html - HTML content
 * @returns {string} - Plain text
 */
function extractTextFromHtml(html) {
  if (!html) return '';

  try {
    // Simple HTML tag removal using regex
    // This is a basic implementation - in a browser environment,
    // we would use the DOM API for better results
    return html
      .replace(/<[^>]*>/g, ' ') // Replace tags with spaces
      .replace(/\s+/g, ' ')     // Normalize whitespace
      .trim();
  } catch (error) {
    logger.error('Error extracting text from HTML', { error: error.message });
    return '';
  }
}

module.exports = searchConfluence;