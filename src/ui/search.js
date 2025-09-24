// Preload script defines window.api
const searchInput = document.getElementById('search-input');
const resultsContainer = document.getElementById('results-container');
const loadingIndicator = document.getElementById('loading-indicator');
const errorMessage = document.getElementById('error-message');
const noResults = document.getElementById('no-results');

// Integration filters
const integrationFiltersContainer = document.getElementById('integration-filters');
let activeFilters = [];

// Store all results for filtering
let allResults = [];


function debugLog(message, isError = false) {
  if (isError) {
    console.error(message);
  }
}

// Initialize integration filters
function initIntegrationFilters() {
  // Get settings to determine enabled integrations
  window.api.getSettings();
  window.api.onSettings((settings) => {
    debugLog('Received settings for integration filters');

    // Clear existing filters
    integrationFiltersContainer.innerHTML = '';

    // Create filters for enabled integrations
    if (settings.integrations) {
      const integrations = settings.integrations;

      if (integrations.jira && integrations.jira.enabled) {
        addIntegrationFilter('jira', 'Jira');
      }

      if (integrations.confluence && integrations.confluence.enabled) {
        addIntegrationFilter('confluence', 'Confluence');
      }

      if (integrations.azureDevops && integrations.azureDevops.enabled) {
        addIntegrationFilter('azureDevops', 'Azure DevOps');
      }

      if (integrations.asana && integrations.asana.enabled) {
        addIntegrationFilter('asana', 'Asana');
      }
    }
  });
}

// Add an integration filter
function addIntegrationFilter(id, label) {
  const filter = document.createElement('div');
  filter.className = 'integration-filter';
  filter.dataset.id = id;
  filter.textContent = label;

  // Add click event to toggle filter
  filter.addEventListener('click', () => {
    filter.classList.toggle('active');

    // Update active filters
    if (filter.classList.contains('active')) {
      if (!activeFilters.includes(id)) {
        activeFilters.push(id);
      }
    } else {
      activeFilters = activeFilters.filter(f => f !== id);
    }

    // If there's a current search query and results exist, re-run the search with updated filters
    const currentQuery = searchInput.value.trim();
    if (currentQuery.length >= 2 && allResults.length > 0) {
      // Parse the query to check for integration prefix
      const { prefix, actualQuery, targetIntegration } = parseQueryWithPrefix(currentQuery);

      // Use the actual query (without prefix) if a prefix was detected, otherwise use full query
      const searchQuery = targetIntegration ? actualQuery : currentQuery;

      // Only proceed if we have a valid search query
      if (searchQuery.length >= 2 || (targetIntegration && actualQuery.length > 0)) {
        // Clear existing results and show loading
        clearResults();
        loadingIndicator.style.display = 'block';

        // Re-run the search with the updated filters
        try {
          window.api.search(searchQuery, activeFilters);
        } catch (error) {
          debugLog(`Error re-running search after filter change: ${error.message}`, true);
          showError(`Error re-running search: ${error.message}`);
        }
      } else {
        // If search query is too short after parsing, just filter existing results
        filterResults();
      }
    } else if (allResults.length > 0) {
      // If no current query or query is too short, just filter existing results
      filterResults();
    }
  });

  integrationFiltersContainer.appendChild(filter);
}

// Filter results based on active filters
function filterResults() {
  debugLog(`Filtering results with active filters: ${activeFilters.join(', ')}`);

  // Filter results based on source
  const filteredResults = allResults.filter(result => {
    const source = result.source.toLowerCase();
    return activeFilters.some(filter => {
      // Handle each integration type specifically
      switch (filter) {
        case 'jira':
          return source.includes('jira');
        case 'confluence':
          return source.includes('confluence');
        case 'azureDevops':
          return source.includes('azure') || source.includes('devops');
        case 'asana':
          return source.includes('asana');
        default:
          // Fallback to generic matching
          return source.includes(filter.toLowerCase());
      }
    });
  });

  // Display filtered results
  displayResults(filteredResults);
}

// Display search results
function displayResults(results) {
  // Clear previous results
  clearResultElements();

  debugLog(`Displaying ${results.length} results`);

  if (results.length === 0) {
    debugLog('No results to display, showing "No results found" message');
    noResults.style.display = 'block';
    return;
  } else {
    noResults.style.display = 'none';
  }

  results.forEach(result => {
    const resultItem = document.createElement('div');
    resultItem.className = 'result-item';
    resultItem.dataset.id = result.id;
    resultItem.dataset.source = result.source;

    // Add click handler to open the result
    resultItem.addEventListener('click', () => {
      if (result.url) {
        debugLog(`Opening URL: ${result.url}`);

        // Prepare result data for click tracking
        const resultData = {
          id: result.id,
          title: result.title,
          source: result.source,
          query: searchInput.value.trim(), // Current search query
          relevanceScore: result.relevanceScore
        };

        window.api.openUrl(result.url, resultData);
      } else {
        debugLog('Result has no URL to open', true);
      }
    });

    // Create source icon
    const sourceIconContainer = document.createElement('div');
    sourceIconContainer.className = 'source-icon';

    // Determine icon/color based on source type
    let iconBackground = '#7c5cff';
    let sourceInitial = '?';

    const sourceLower = result.source.toLowerCase();
    if (sourceLower.includes('jira')) {
      iconBackground = '#0052CC';
      sourceInitial = 'J';
    } else if (sourceLower.includes('confluence')) {
      iconBackground = '#1A73E8';
      sourceInitial = 'C';
    } else if (sourceLower.includes('azure') || sourceLower.includes('devops')) {
      iconBackground = '#0078D7';
      sourceInitial = 'A';
    } else if (sourceLower.includes('asana')) {
      iconBackground = '#F06A6A';
      sourceInitial = 'A';
    } else if (sourceLower.includes('github')) {
      iconBackground = '#24292e';
      sourceInitial = 'G';
    } else if (sourceLower.includes('notion')) {
      iconBackground = '#000000';
      sourceInitial = 'N';
    }

    sourceIconContainer.style.backgroundColor = iconBackground;
    sourceIconContainer.textContent = sourceInitial;

    // Create content container
    const contentContainer = document.createElement('div');
    contentContainer.className = 'result-content';

    const resultTitle = document.createElement('div');
    resultTitle.className = 'result-title';
    resultTitle.textContent = result.title;

    const resultDescription = document.createElement('div');
    resultDescription.className = 'result-description';
    resultDescription.textContent = result.description || 'No description available';

    // Create metadata container with source and update info
    const resultMeta = document.createElement('div');
    resultMeta.className = 'result-meta';

    // Create source badge
    const sourceBadge = document.createElement('span');
    sourceBadge.className = 'source-badge';
    sourceBadge.textContent = result.source;

    // Add other metadata if available
    const metaItems = [sourceBadge];

    // Add ID/key if available
    if (result.id) {
      const idBadge = document.createElement('span');
      idBadge.className = 'meta-item';
      idBadge.textContent = result.id;
      metaItems.push(idBadge);
    }

    // Add enhanced metadata based on source type
    if (result.metadata) {
      const metadata = result.metadata;

      // Add priority indicator for Jira and Azure DevOps
      if ((result.source.toLowerCase().includes('jira') || result.source.toLowerCase().includes('azure')) && metadata.priority) {
        const priorityBadge = document.createElement('span');
        priorityBadge.className = 'meta-item priority-badge';
        priorityBadge.textContent = metadata.priority;

        // Color code priority
        if (metadata.priority.toLowerCase().includes('high') || metadata.priority === '1' || metadata.priority.toLowerCase().includes('critical')) {
          priorityBadge.style.backgroundColor = 'var(--error-color)';
          priorityBadge.style.color = 'white';
        } else if (metadata.priority.toLowerCase().includes('medium') || metadata.priority === '2') {
          priorityBadge.style.backgroundColor = 'var(--warning-color)';
          priorityBadge.style.color = 'white';
        } else {
          priorityBadge.style.backgroundColor = 'var(--text-muted)';
          priorityBadge.style.color = 'white';
        }
        priorityBadge.style.padding = '2px 6px';
        priorityBadge.style.borderRadius = '3px';
        priorityBadge.style.fontSize = '0.75em';
        priorityBadge.style.fontWeight = 'bold';
        metaItems.push(priorityBadge);
      }

      // Add assignee information
      if (metadata.assignee && metadata.assignee !== 'Unassigned') {
        const assigneeBadge = document.createElement('span');
        assigneeBadge.className = 'meta-item assignee-badge';
        assigneeBadge.textContent = `👤 ${metadata.assignee}`;
        assigneeBadge.title = `Assigned to ${metadata.assignee}`;
        metaItems.push(assigneeBadge);
      }

      // Add project/space information
      if (metadata.project || metadata.space) {
        const projectBadge = document.createElement('span');
        projectBadge.className = 'meta-item project-badge';
        projectBadge.textContent = `📁 ${metadata.project || metadata.space}`;
        projectBadge.title = `Project: ${metadata.project || metadata.space}`;
        metaItems.push(projectBadge);
      }

      // Add activity indicators
      if (result.activityIndicators) {
        const indicators = result.activityIndicators;

        if (indicators.hasRecentActivity) {
          const activityBadge = document.createElement('span');
          activityBadge.className = 'meta-item activity-badge';
          activityBadge.textContent = '🔥 Active';
          activityBadge.style.backgroundColor = 'var(--success-color)';
          activityBadge.style.color = 'white';
          activityBadge.style.padding = '2px 6px';
          activityBadge.style.borderRadius = '3px';
          activityBadge.style.fontSize = '0.75em';
          activityBadge.title = 'Recent activity within the last week';
          metaItems.push(activityBadge);
        }

        if (indicators.isOverdue) {
          const overdueBadge = document.createElement('span');
          overdueBadge.className = 'meta-item overdue-badge';
          overdueBadge.textContent = '⚠️ Overdue';
          overdueBadge.style.backgroundColor = 'var(--error-color)';
          overdueBadge.style.color = 'white';
          overdueBadge.style.padding = '2px 6px';
          overdueBadge.style.borderRadius = '3px';
          overdueBadge.style.fontSize = '0.75em';
          overdueBadge.style.fontWeight = 'bold';
          metaItems.push(overdueBadge);
        } else if (indicators.isDueSoon) {
          const dueSoonBadge = document.createElement('span');
          dueSoonBadge.className = 'meta-item due-soon-badge';
          dueSoonBadge.textContent = '⏰ Due Soon';
          dueSoonBadge.style.backgroundColor = 'var(--warning-color)';
          dueSoonBadge.style.color = 'white';
          dueSoonBadge.style.padding = '2px 6px';
          dueSoonBadge.style.borderRadius = '3px';
          dueSoonBadge.style.fontSize = '0.75em';
          metaItems.push(dueSoonBadge);
        }

        if (indicators.hasComments || indicators.hasAttachments) {
          const engagementBadge = document.createElement('span');
          engagementBadge.className = 'meta-item engagement-badge';
          const commentCount = metadata.commentCount || 0;
          const attachmentCount = metadata.attachmentCount || 0;

          let engagementText = '';
          if (commentCount > 0 && attachmentCount > 0) {
            engagementText = `💬 ${commentCount} 📎 ${attachmentCount}`;
          } else if (commentCount > 0) {
            engagementText = `💬 ${commentCount} comments`;
          } else if (attachmentCount > 0) {
            engagementText = `📎 ${attachmentCount} files`;
          }

          engagementBadge.textContent = engagementText;
          engagementBadge.title = 'Has comments or attachments';
          metaItems.push(engagementBadge);
        }

        if (indicators.isHighPriority) {
          const highPriorityBadge = document.createElement('span');
          highPriorityBadge.className = 'meta-item high-priority-badge';
          highPriorityBadge.textContent = '🔴 High Priority';
          highPriorityBadge.style.backgroundColor = 'var(--error-color)';
          highPriorityBadge.style.color = 'white';
          highPriorityBadge.style.padding = '2px 6px';
          highPriorityBadge.style.borderRadius = '3px';
          highPriorityBadge.style.fontSize = '0.75em';
          highPriorityBadge.style.fontWeight = 'bold';
          metaItems.push(highPriorityBadge);
        }
      }

      // Add content type indicators for Confluence
      if (result.source.toLowerCase().includes('confluence') && result.activityIndicators) {
        if (result.activityIndicators.hasRichContent) {
          const richContentBadge = document.createElement('span');
          richContentBadge.className = 'meta-item rich-content-badge';
          richContentBadge.textContent = '🎨 Rich Content';
          richContentBadge.title = 'Contains images or macros';
          metaItems.push(richContentBadge);
        }

        if (result.activityIndicators.isLongForm) {
          const longFormBadge = document.createElement('span');
          longFormBadge.className = 'meta-item long-form-badge';
          longFormBadge.textContent = '📄 Long Form';
          longFormBadge.title = 'Contains detailed content (500+ words)';
          metaItems.push(longFormBadge);
        }
      }

      // Add estimate indicators for Azure DevOps
      if (result.source.toLowerCase().includes('azure') && result.activityIndicators?.hasEstimates) {
        const estimateBadge = document.createElement('span');
        estimateBadge.className = 'meta-item estimate-badge';
        if (metadata.storyPoints) {
          estimateBadge.textContent = `📊 ${metadata.storyPoints} pts`;
        } else if (metadata.originalEstimate) {
          estimateBadge.textContent = `⏱️ ${Math.round(metadata.originalEstimate / 3600)}h`;
        }
        estimateBadge.title = 'Has effort estimates';
        metaItems.push(estimateBadge);
      }
    }

    // Add relevance score if available and enabled in settings
    if (result.relevanceScore && result.relevanceScore > 0 && window.searchSettings?.showRelevanceScores) {
      const scoreBadge = document.createElement('span');
      scoreBadge.className = 'meta-item relevance-score';
      scoreBadge.textContent = `Score: ${result.relevanceScore.toFixed(2)}`;
      scoreBadge.style.fontSize = '0.75em';
      scoreBadge.style.opacity = '0.7';
      scoreBadge.title = `BM25: ${result._scoring?.bm25?.toFixed(2) || 'N/A'}, Recency: ${result._scoring?.recency?.toFixed(2) || 'N/A'}, Source: ${result._scoring?.source?.toFixed(2) || 'N/A'}`;
      metaItems.push(scoreBadge);
    }

    // Format the updated date if available
    if (result.updated) {
      try {
        const updatedDate = new Date(result.updated);
        const timeAgo = getTimeAgo(updatedDate);

        const updatedBadge = document.createElement('span');
        updatedBadge.className = 'meta-item';
        updatedBadge.textContent = `Updated ${timeAgo}`;
        metaItems.push(updatedBadge);
      } catch (e) {
        debugLog(`Error formatting date: ${e.message}`, true);
      }
    }

    // Add all metadata items to container
    metaItems.forEach(item => resultMeta.appendChild(item));

    // Add external link indicator
    const externalLink = document.createElement('div');
    externalLink.className = 'external-link';
    externalLink.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';

    // Assemble the result item
    contentContainer.appendChild(resultTitle);
    contentContainer.appendChild(resultDescription);
    contentContainer.appendChild(resultMeta);

    resultItem.appendChild(sourceIconContainer);
    resultItem.appendChild(contentContainer);
    resultItem.appendChild(externalLink);

    resultsContainer.appendChild(resultItem);
  });
}

// Helper function to format time ago
function getTimeAgo(date) {
  const now = new Date();
  const diffInSeconds = Math.floor((now - date) / 1000);

  if (diffInSeconds < 60) {
    return 'just now';
  }

  const diffInMinutes = Math.floor(diffInSeconds / 60);
  if (diffInMinutes < 60) {
    return `${diffInMinutes} minute${diffInMinutes > 1 ? 's' : ''} ago`;
  }

  const diffInHours = Math.floor(diffInMinutes / 60);
  if (diffInHours < 24) {
    return `${diffInHours} hour${diffInHours > 1 ? 's' : ''} ago`;
  }

  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 30) {
    return `${diffInDays} day${diffInDays > 1 ? 's' : ''} ago`;
  }

  const diffInMonths = Math.floor(diffInDays / 30);
  if (diffInMonths < 12) {
    return `${diffInMonths} month${diffInMonths > 1 ? 's' : ''} ago`;
  }

  const diffInYears = Math.floor(diffInMonths / 12);
  return `${diffInYears} year${diffInYears > 1 ? 's' : ''} ago`;
}

// Focus the search input when the window loads
window.onload = () => {
  debugLog('Search window loaded');
  searchInput.focus();
  initIntegrationFilters();
  loadIntegrationShortcuts();
  initHelpButton();
};

// Get integration shortcuts from settings
let integrationShortcuts = {};
let enabledIntegrations = [];

// Initialize help button functionality
function initHelpButton() {
  const helpButton = document.getElementById('help-button');
  const helpTooltip = document.getElementById('help-tooltip');
  let tooltipVisible = false;

  // Toggle tooltip on click
  helpButton.addEventListener('click', (event) => {
    event.stopPropagation();
    tooltipVisible = !tooltipVisible;

    if (tooltipVisible) {
      helpTooltip.classList.add('visible');
    } else {
      helpTooltip.classList.remove('visible');
    }
  });

  // Hide tooltip when clicking outside
  document.addEventListener('click', (event) => {
    if (!helpButton.contains(event.target) && !helpTooltip.contains(event.target)) {
      tooltipVisible = false;
      helpTooltip.classList.remove('visible');
    }
  });

  // Prevent tooltip from closing when clicking inside it
  helpTooltip.addEventListener('click', (event) => {
    event.stopPropagation();
  });
}

function loadIntegrationShortcuts() {
  window.api.getSettings();
  window.api.onSettings((settings) => {
    // Load search settings
    window.searchSettings = settings.searchSettings || { showRelevanceScores: false, enableBM25Scoring: true };

    if (settings.integrations) {
      // Reset the shortcuts and enabled integrations
      integrationShortcuts = {};
      enabledIntegrations = [];

      // Map each integration to its shortcut, but only if the integration is enabled
      if (settings.integrations.jira) {
        if (settings.integrations.jira.enabled) {
          enabledIntegrations.push('jira');
          if (settings.integrations.jira.searchShortcut) {
            integrationShortcuts.jira = settings.integrations.jira.searchShortcut.toLowerCase();
          }
        }
      }

      if (settings.integrations.confluence) {
        if (settings.integrations.confluence.enabled) {
          enabledIntegrations.push('confluence');
          if (settings.integrations.confluence.searchShortcut) {
            integrationShortcuts.confluence = settings.integrations.confluence.searchShortcut.toLowerCase();
          }
        }
      }

      if (settings.integrations.azureDevops) {
        if (settings.integrations.azureDevops.enabled) {
          enabledIntegrations.push('azureDevops');
          if (settings.integrations.azureDevops.searchShortcut) {
            integrationShortcuts.azureDevops = settings.integrations.azureDevops.searchShortcut.toLowerCase();
          }
        }
      }

      if (settings.integrations.asana) {
        if (settings.integrations.asana.enabled) {
          enabledIntegrations.push('asana');
          if (settings.integrations.asana.searchShortcut) {
            integrationShortcuts.asana = settings.integrations.asana.searchShortcut.toLowerCase();
          }
        }
      }

      debugLog(`Loaded integration shortcuts for enabled integrations: ${JSON.stringify(integrationShortcuts)}`);
      debugLog(`Enabled integrations: ${enabledIntegrations.join(', ')}`);
    }
  });
}

// Parse query for integration prefix
function parseQueryWithPrefix(query) {
  // First, check if the entire query exactly matches a shortcut
  // This handles the case where the user has only typed the shortcut so far
  const queryLower = query.toLowerCase();
  for (const [integration, shortcut] of Object.entries(integrationShortcuts)) {
    if (queryLower === shortcut) {
      // If the entire query is just the shortcut, return an empty actual query
      return { prefix: queryLower, actualQuery: '', targetIntegration: integration };
    }
  }

  // If not an exact match, split the query by the first space
  const parts = query.split(/\s+/);

  // If there's no space, check if the query starts with a shortcut
  if (parts.length < 2) {
    // Check if the query starts with any shortcut
    for (const [integration, shortcut] of Object.entries(integrationShortcuts)) {
      if (queryLower.startsWith(shortcut)) {
        // Extract the part after the shortcut
        const actualQuery = queryLower.substring(shortcut.length).trim();
        return { prefix: shortcut, actualQuery, targetIntegration: integration };
      }
    }
    // No matching prefix found
    return { prefix: null, actualQuery: query, targetIntegration: null };
  }

  // If there's a space, check if the first part is a shortcut
  const potentialPrefix = parts[0].toLowerCase();

  // Check if the potential prefix matches any integration shortcut
  let targetIntegration = null;
  for (const [integration, shortcut] of Object.entries(integrationShortcuts)) {
    if (potentialPrefix === shortcut) {
      targetIntegration = integration;
      break;
    }
  }

  if (targetIntegration) {
    // Remove the prefix and return the actual query
    const actualQuery = parts.slice(1).join(' ');
    return { prefix: potentialPrefix, actualQuery, targetIntegration };
  }

  // No matching prefix found
  return { prefix: null, actualQuery: query, targetIntegration: null };
}

// Select an integration filter by ID
function selectIntegrationFilter(integrationId) {
  // Clear all active filters first
  activeFilters = [];

  // Update UI to reflect the selected filter
  const filters = integrationFiltersContainer.querySelectorAll('.integration-filter');
  filters.forEach(filter => {
    if (filter.dataset.id === integrationId) {
      filter.classList.add('active');
      activeFilters.push(integrationId);
    } else {
      filter.classList.remove('active');
    }
  });

  debugLog(`Selected integration filter: ${integrationId}`);
}

// Handle search input
let searchTimeout;
let lastDetectedIntegration = null;

searchInput.addEventListener('input', (event) => {
  const query = event.target.value.trim();

  // Check for integration prefix on every keystroke
  const { prefix, actualQuery, targetIntegration } = parseQueryWithPrefix(query);

  // Update filters immediately if a prefix is detected or if the prefix has changed/been removed
  if (targetIntegration !== lastDetectedIntegration) {
    if (targetIntegration) {
      // If a valid prefix was found, update the active filters
      selectIntegrationFilter(targetIntegration);
      debugLog(`Detected prefix "${prefix}" for integration "${targetIntegration}". Actual query: "${actualQuery}"`);
    } else if (lastDetectedIntegration) {
      // If we previously had a prefix but now don't, clear the filters
      activeFilters = [];
      const filters = integrationFiltersContainer.querySelectorAll('.integration-filter');
      filters.forEach(filter => {
        filter.classList.remove('active');
      });
      debugLog('Prefix removed, cleared filters');
    }

    // Update the last detected integration
    lastDetectedIntegration = targetIntegration;
  }

  // Clear previous timeout
  clearTimeout(searchTimeout);

  // Clear previous results
  clearResults();

  if (query.length === 0) {
    // Ensure no results are shown when search is empty
    return;
  }

  // Only show loading indicator and start search if query has at least 2 characters
  // OR if it's a valid prefix (which means we'll wait for more input)
  if (query.length < 2 && !targetIntegration) {
    return;
  }

  // If we only have a prefix with no actual query, don't search yet
  if (targetIntegration && actualQuery.length === 0) {
    debugLog(`Detected prefix "${prefix}" for integration "${targetIntegration}". Waiting for search term...`);
    return;
  }

  // Show loading indicator
  loadingIndicator.style.display = 'block';

  // Debounce search to avoid too many requests
  // Increased timeout to 800ms to give users more time to finish typing
  searchTimeout = setTimeout(() => {
    // Use the actual query (without prefix) if a prefix was detected, otherwise use the original query
    const searchQuery = targetIntegration ? actualQuery : query;

    debugLog(`Searching for: ${searchQuery} (Filters: ${activeFilters.join(', ') || 'None'})`);
    try {
      // Pass active filters with the search query
      window.api.search(searchQuery, activeFilters);
    } catch (error) {
      debugLog(`Error initiating search: ${error.message}`, true);
      showError(`Error initiating search: ${error.message}`);
    }
  }, 800);
});

// Handle search results
window.api.onSearchResults((data) => {
  debugLog(`Received search results: ${JSON.stringify(data)}`);

  // Hide loading indicator
  loadingIndicator.style.display = 'none';

  // Clear previous results
  clearResults();

  // Check for errors
  if (data.errors && data.errors.length > 0) {
    debugLog(`Search errors: ${JSON.stringify(data.errors)}`, true);
    showError(data.errors.map(e => e.error).join(', '));
    return;
  }

  // Get the results array
  const results = data.results || [];

  // Log sources for debugging
  if (results.length > 0) {
    const sources = results.map(r => r.source);
    const uniqueSources = [...new Set(sources)];
    debugLog(`Result sources: ${uniqueSources.join(', ')}`);
  }

  // Store all results for filtering
  allResults = results;

  // Apply any active filters
  if (activeFilters.length > 0) {
    filterResults();
  } else {
    // Display all results if no filters are active
    displayResults(results);
  }
});

window.api.onOpenUrlError((message) => {
  debugLog(`Failed to open URL: ${message}`, true);
  showError(message);
});

// Clear results and UI elements
function clearResults() {
  // Hide messages
  loadingIndicator.style.display = 'none';
  errorMessage.style.display = 'none';
  noResults.style.display = 'none';

  // Clear stored results
  allResults = [];

  // Clear result elements
  clearResultElements();
}

// Clear only the result elements from the UI
function clearResultElements() {
  // Remove all result items
  while (resultsContainer.firstChild) {
    resultsContainer.removeChild(resultsContainer.firstChild);
  }
}

// Show error message
function showError(message) {
  errorMessage.textContent = message;
  errorMessage.style.display = 'block';
  loadingIndicator.style.display = 'none';
  noResults.style.display = 'none';
}

// Handle keyboard shortcuts
document.addEventListener('keydown', (event) => {
  // Close window on Escape
  if (event.key === 'Escape') {
    window.close();
  }
});

// Trigger search function (used by input and sort buttons)
function triggerSearch() {
  const query = searchInput.value.trim();


  // Parse the query for integration prefix
  const { prefix, actualQuery, targetIntegration } = parseQueryWithPrefix(query);

  // Update filters if needed (should already be updated by the input handler, but just to be safe)
  if (targetIntegration !== lastDetectedIntegration) {
    if (targetIntegration) {
      selectIntegrationFilter(targetIntegration);
      debugLog(`Detected prefix "${prefix}" for integration "${targetIntegration}". Actual query: "${actualQuery}"`);
    } else if (lastDetectedIntegration) {
      // If we previously had a prefix but now don't, clear the filters
      activeFilters = [];
      const filters = integrationFiltersContainer.querySelectorAll('.integration-filter');
      filters.forEach(filter => {
        filter.classList.remove('active');
      });
      debugLog('Prefix removed, cleared filters');
    }

    // Update the last detected integration
    lastDetectedIntegration = targetIntegration;
  }

  // Don't search if query is too short or if we only have a prefix with no actual query
  if ((query.length < 2 && !targetIntegration) || (targetIntegration && actualQuery.length === 0)) {
    debugLog('Query too short or only prefix detected. Not searching yet.');
    return;
  }

  // Clear existing timeout and results
  clearTimeout(searchTimeout);
  clearResults();
  loadingIndicator.style.display = 'block';

  // Use the actual query (without prefix) if a prefix was detected, otherwise use the original query
  const searchQuery = targetIntegration ? actualQuery : query;

  debugLog(`Triggering search for: ${searchQuery} (Filters: ${activeFilters.join(', ') || 'None'})`);
  try {
    window.api.search(searchQuery, activeFilters);
  } catch (error) {
    debugLog(`Error initiating search: ${error.message}`, true);
    showError(`Error initiating search: ${error.message}`);
  }
}