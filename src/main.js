const { app, BrowserWindow, globalShortcut, ipcMain, shell, Tray, Menu, dialog } = require('electron');
const path = require('path');
const ElectronStore = require('electron-store');
const Store = ElectronStore.default || ElectronStore;
const fs = require('fs');
const AutoLaunch = require('auto-launch');
const keytar = require('keytar');

// Import new utilities
const Logger = require('./utils/logger');
const { setupGlobalErrorHandlers, getCircuitBreaker, defaultRetryMechanism } = require('./utils/error-handling');
const { generateCorrelationId, handleApiError } = require('./integrations/utils');
const { createConfigManagers } = require('./utils/config-manager');
const { sanitizeSettingsForRenderer, sanitizeTestConfig, SENSITIVE_VALUE_MASK } = require('./utils/credential-sanitizer');

const integrationRegistry = require('./integrations/registry');

// Relevance scoring
const { calculateRelevanceScores, updateUserContext } = require('./relevance-scorer');

// Initialize logger
const logger = new Logger({
  component: 'MainProcess',
  logLevel: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  logToFile: true
});

// Initialize configuration managers
const configs = createConfigManagers();

const integrationDefaults = Object.entries(integrationRegistry).reduce((acc, [id, definition]) => {
  acc[id] = { ...definition.configDefaults };
  return acc;
}, {});

// Legacy config store for migration (will be removed after full migration)
const store = new Store({
  defaults: {
    shortcut: 'CommandOrControl+Shift+Space',
    minimizeToTray: true,
    launchOnStart: false,
    integrations: integrationDefaults,
    userContext: {
      sourcePreferences: {}
    },
    searchSettings: {
      showRelevanceScores: false,
      enableBM25Scoring: true
    }
  }
});


// Allow-list of settings that may be updated from the renderer process

const BASE_ALLOWED_SETTING_KEYS = ['shortcut', 'minimizeToTray', 'launchOnStart'];

const ALLOWED_SETTING_KEYS = new Set([
  ...BASE_ALLOWED_SETTING_KEYS,
  ...Object.entries(integrationRegistry).flatMap(([id, definition]) =>
    definition.allowedKeys.map((field) => `integrations.${id}.${field}`)
  )
]);

// Setting keys that should always be stored securely via keytar
const SENSITIVE_SETTING_KEYS = new Set(
  Object.entries(integrationRegistry).flatMap(([id, definition]) =>
    definition.sensitiveKeys.map((field) => `integrations.${id}.${field}`)
  )
);

const KEYTAR_SERVICE = 'SearchSync';
const KEYTAR_ENV_CHECK_ACCOUNT = 'secure-storage-check';

async function ensureSecureStorageAvailable() {
  const correlationId = generateCorrelationId();
  try {
    logger.info('Checking secure storage availability', { correlationId });
    await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ENV_CHECK_ACCOUNT, 'ok');
    await keytar.deletePassword(KEYTAR_SERVICE, KEYTAR_ENV_CHECK_ACCOUNT);
    logger.info('Secure storage is available', { correlationId });
  } catch (error) {
    logger.error('Secure credential storage is unavailable', {
      error: error.message,
      correlationId
    });
    dialog.showErrorBox(
      'Secure storage required',
      'SearchSync requires access to the system credential store. Please ensure that a supported credential manager is installed and try again.'
    );
    throw error;
  }
}

function getSecretAccountName(settingKey) {
  return settingKey;
}

async function setSecureSetting(settingKey, value) {
  const account = getSecretAccountName(settingKey);
  const correlationId = generateCorrelationId();

  try {
    if (typeof value === 'string' && value.length > 0) {
      // Store directly in keytar without temporary config storage
      await keytar.setPassword(KEYTAR_SERVICE, account, value);
      // Store only a marker + last persisted timestamp so we know a credential exists
      store.set(settingKey, {
        hasCredential: true,
        lastUpdated: new Date().toISOString()
      });

      // Clear sensitive data from memory immediately
      value = '';

      logger.debug('Secure setting stored', {
        settingKey,
        correlationId
      });
    } else {
      await keytar.deletePassword(KEYTAR_SERVICE, account);
      store.set(settingKey, {
        hasCredential: false,
        lastUpdated: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('Failed to store secure setting', {
      settingKey,
      error: error.message,
      correlationId
    });
    throw new Error('Failed to store sensitive data securely');
  }
}

async function getSecureSetting(settingKey) {
  const account = getSecretAccountName(settingKey);
  const correlationId = generateCorrelationId();

  try {
    const value = await keytar.getPassword(KEYTAR_SERVICE, account);

    logger.debug('Secure setting retrieved', {
      settingKey,
      hasValue: !!value,
      correlationId
    });

    return value || '';
  } catch (error) {
    logger.error('Failed to retrieve secure setting', {
      settingKey,
      error: error.message,
      correlationId
    });
    return '';
  }
}

async function getIntegrationsWithSecrets() {
  const correlationId = generateCorrelationId();
  logger.debug('getIntegrationsWithSecrets called', { correlationId });

  const resolved = {};

  for (const [id, definition] of Object.entries(integrationRegistry)) {
    resolved[id] = {};

    if (definition?.configDefaults && typeof definition.configDefaults === 'object') {
      Object.assign(resolved[id], definition.configDefaults);
    }

    if (configs.integrations && configs.integrations[id]) {
      try {
        const managerConfig = configs.integrations[id].getAll();
        if (managerConfig && typeof managerConfig === 'object') {
          Object.assign(resolved[id], managerConfig);
        }
        logger.debug(`Got config for ${id}`, { correlationId });
      } catch (error) {
        logger.warn(`Failed to get integration config for ${id}`, {
          error: error.message,
          correlationId
        });
      }
    } else {
      logger.warn(`No config manager found for ${id}`, {
        hasIntegrations: !!configs.integrations,
        integrationId: id,
        correlationId
      });
    }

    if (Array.isArray(definition.sensitiveKeys)) {
      for (const secretKey of definition.sensitiveKeys) {
        const storeKey = `integrations.${id}.${secretKey}`;
        resolved[id][secretKey] = await getSecureSetting(storeKey);
      }
    }
  }

  logger.debug('getIntegrationsWithSecrets completed', {
    integrationIds: Object.keys(resolved),
    correlationId
  });

  return resolved;
}

let mainWindow;
let searchWindow;
let tray = null;

// Initialize auto-launch
const autoLauncher = new AutoLaunch({
  name: 'SearchSync',
  path: app.getPath('exe'),
  isHidden: true
});

// Set quitting flag before the quit process begins to avoid minimizing to tray
app.on('before-quit', () => {
  app.isQuitting = true;
});

function createTray() {
  if (tray) return; // Don't create tray if it already exists

  // Define icon paths
  const iconPaths = {
    win: [
      path.join(__dirname, '..', 'build', 'icon.ico'),
      path.join(__dirname, 'assets', 'icon.ico'),
      path.join(__dirname, 'assets', 'icon.png')
    ],
    other: [
      path.join(__dirname, 'assets', 'icon.png')
    ]
  };

  // Select platform-specific icon paths
  const paths = process.platform === 'win32' ? iconPaths.win : iconPaths.other;

  // Find first existing icon
  let iconPath = null;
  for (const p of paths) {
    if (fs.existsSync(p)) {
      iconPath = p;
      break;
    }
  }

  try {
    tray = new Tray(iconPath);
    tray.setToolTip('SearchSync');
  } catch (error) {
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Open SearchSync',
      click: () => {
        if (mainWindow) {
          if (mainWindow.isMinimized()) mainWindow.restore();
          mainWindow.show();
          mainWindow.focus();
        } else {
          createMainWindow();
        }
      }
    },
    {
      label: 'Search',
      click: () => {
        createSearchWindow();
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        // Ensure quitting flag is set and then quit
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);

  // Double-click on tray icon shows the main window
  tray.on('double-click', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createMainWindow();
    }
  });

  // Single click on tray icon shows the main window (Windows only)
  if (process.platform === 'win32') {
    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
      } else {
        createMainWindow();
      }
    });
  }
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'settings.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  // Handle minimize event
  mainWindow.on('minimize', (event) => {
    const minimizeToTray = configs.ui.get('showInTray');
    if (minimizeToTray) {
      event.preventDefault();
      mainWindow.hide();
      if (!tray) createTray();
    }
  });

  // Handle close event
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      const minimizeToTray = configs.ui.get('showInTray');
      if (minimizeToTray) {
        event.preventDefault();
        mainWindow.hide();
        if (!tray) createTray();
        return false;
      }
    }
    return true;
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createSearchWindow() {
  if (searchWindow) {
    searchWindow.focus();
    return;
  }

  searchWindow = new BrowserWindow({
    width: 600,
    height: 400,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  searchWindow.loadFile(path.join(__dirname, 'ui', 'search.html'));

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    searchWindow.webContents.openDevTools();
  }

  searchWindow.on('blur', () => {
    searchWindow.close();
  });

  searchWindow.on('closed', () => {
    searchWindow = null;
  });
}

// Setup global error handlers
setupGlobalErrorHandlers();

// Main application initialization
app.whenReady().then(async () => {
  const correlationId = generateCorrelationId();
  logger.info('Application starting', { correlationId, version: app.getVersion() });

  await ensureSecureStorageAvailable();

  // Register global shortcuts
  const shortcut = configs.ui.get('hotkey') || 'CommandOrControl+Shift+Space';
  globalShortcut.register(shortcut, () => {
    logger.debug('Global shortcut triggered', { shortcut });
    createSearchWindow();
  });

  if (!globalShortcut.isRegistered(shortcut)) {
    logger.error(`Failed to register global shortcut: ${shortcut}`, { correlationId });
  }

  createMainWindow();

  // Create the tray icon if minimizeToTray is enabled
  if (configs.ui.get('showInTray')) {
    createTray();
  }

  logger.info('Application initialized successfully', { correlationId });

}).catch(error => {
  const correlationId = generateCorrelationId();
  logger.error('Failed to complete app initialization', {
    error: error.message,
    stack: error.stack,
    correlationId
  });
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  // Unregister all shortcuts
  globalShortcut.unregisterAll();

  // Set flag to allow the app to quit
  app.isQuitting = true;

  // Destroy tray
  if (tray) {
    tray.destroy();
    tray = null;
  }

  });

// IPC handlers for search functionality
ipcMain.on('search', async (event, query, activeFilters = []) => {
  const correlationId = generateCorrelationId();
  logger.info('Search request received', { queryLength: query?.length, activeFilters, correlationId });

  // Input validation
  if (typeof query !== 'string') {
    logger.warn('Invalid search query type received', { type: typeof query, correlationId });
    event.reply('search-results', {
      results: [],
      errors: [{ source: 'SearchSync', error: 'Invalid search query received.' }]
    });
    return;
  }

  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    logger.warn('Empty search query received', { correlationId });
    event.reply('search-results', {
      results: [],
      errors: [{ source: 'SearchSync', error: 'Search query cannot be empty.' }]
    });
    return;
  }

  const safeFilters = Array.isArray(activeFilters)
    ? activeFilters.filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
    : [];

  let integrations;
  try {
    integrations = await getIntegrationsWithSecrets();
  } catch (error) {
    logger.error('Failed to load integrations with secrets', {
      error: error.message,
      correlationId
    });
    event.reply('search-results', {
      results: [],
      errors: [{ source: 'SearchSync', error: 'Secure credential storage is unavailable.' }]
    });
    return;
  }

  const results = [];
  const errors = [];

  // Build search tasks for enabled/filtered integrations and run them concurrently
  const tasks = [];

  for (const [id, definition] of Object.entries(integrationRegistry)) {
    const integrationConfig = integrations[id] || {};
    const isEnabled = integrationConfig.enabled !== undefined ? Boolean(integrationConfig.enabled) : true;
    const filterAllowed = safeFilters.length === 0 || safeFilters.includes(definition.filterKey);

    if (!isEnabled || !filterAllowed) {
      continue;
    }

    const validationMessage = definition.validateSearchConfig
      ? definition.validateSearchConfig(integrationConfig)
      : null;

    if (validationMessage) {
      errors.push({ source: definition.sourceName, error: validationMessage });
      logger.warn('Integration validation failed', {
        integration: id,
        validationMessage,
        correlationId
      });
      continue;
    }

    const extractor = typeof definition.resultExtractor === 'function'
      ? definition.resultExtractor
      : (value) => (Array.isArray(value) ? value : []);

    // Create circuit breaker for each integration
    const circuitBreaker = getCircuitBreaker(id, {
      threshold: 3,
      timeout: 30000,
      resetTimeout: 60000
    });

    tasks.push({
      source: definition.sourceName,
      extract: extractor,
      promise: circuitBreaker.execute(
        () => definition.searchHandler(trimmedQuery, integrationConfig),
        { correlationId, integration: id }
      )
    });
  }

  // Execute all tasks concurrently and collect results/errors
  if (tasks.length > 0) {
    const settled = await Promise.allSettled(tasks.map(t => t.promise));
    settled.forEach((s, idx) => {
      const { source, extract } = tasks[idx];
      if (s.status === 'fulfilled') {
        try {
          const arr = extract(s.value) || [];
          if (Array.isArray(arr) && arr.length > 0) {
            results.push(...arr);
            logger.debug(`Received ${arr.length} results from ${source}`, {
              source,
              correlationId
            });
          }
        } catch (e) {
          const errorMessage = handleApiError(e, source, correlationId);
          errors.push({ source, error: errorMessage });
          logger.error('Failed to process integration results', {
            source,
            error: e.message,
            correlationId
          });
        }
      } else {
        const errorMessage = handleApiError(s.reason, source, correlationId);
        errors.push({ source, error: errorMessage });
        logger.error('Integration search failed', {
          source,
          error: s.reason?.message,
          correlationId
        });
      }
    });
  } else {
    logger.warn('No integration tasks to execute', {
      availableIntegrations: Object.keys(integrationRegistry).length,
      correlationId
    });
  }

  let finalResults = [];

  try {
    // Get user context for personalization from new config system
    const userContext = configs.app.get('userContext', {});
    const searchSettings = {
      enableBM25Scoring: configs.app.get('enableBM25Scoring', true),
      maxResults: configs.app.get('maxResults', 50)
    };

    if (searchSettings.enableBM25Scoring && results.length > 0) {
      // Calculate BM25 relevance scores and sort by relevance
      finalResults = calculateRelevanceScores(results, trimmedQuery, userContext);
    } else {
      // Fallback to date sorting if BM25 is disabled or no results
      finalResults = sortResultsByDate(results);
    }


    logger.info('Search completed successfully', {
      query: trimmedQuery,
      resultCount: finalResults.length,
      errorCount: errors.length,
      correlationId
    });

    event.reply('search-results', {
      results: finalResults,
      errors
    });
  } catch (processingError) {
    logger.error('Failed to process search results', {
      error: processingError.message,
      correlationId
    });

    // Fallback to date sorting if BM25 scoring fails
    try {
      finalResults = sortResultsByDate(results);
      event.reply('search-results', {
        results: finalResults,
        errors: [...errors, { source: 'Scoring', error: `Failed to calculate relevance scores: ${processingError.message}` }]
      });
    } catch (fallbackError) {
      logger.error('Fallback sorting also failed', {
        error: fallbackError.message,
        originalError: processingError.message,
        correlationId
      });

      // Send original, unsorted results if everything fails
      event.reply('search-results', {
        results: results,
        errors: [...errors, { source: 'Sorting', error: `Failed to process/sort results: ${processingError.message}` }]
      });
    }
  }
});

// IPC handlers for settings
ipcMain.on('get-settings', async (event) => {
  const correlationId = generateCorrelationId();
  try {
    
    // Get settings from new config managers
    const settings = {
      app: configs.app.getAll(),
      ui: configs.ui.getAll(),
      integrations: await getIntegrationsWithSecrets()
    };

    // Add shortcut and other UI settings
    settings.shortcut = configs.ui.get('hotkey');
    settings.minimizeToTray = configs.ui.get('showInTray');
    settings.launchOnStart = configs.ui.get('launchOnStart');

    // Add search settings from app config
    settings.searchSettings = {
      enableBM25Scoring: configs.app.get('enableBM25Scoring', true),
      maxResults: configs.app.get('maxResults', 50),
      showRelevanceScores: configs.app.get('showRelevanceScores', false)
    };

    // Sanitize settings before sending to renderer - never expose actual credentials
    const sanitizedSettings = sanitizeSettingsForRenderer(settings);

    logger.debug('Settings retrieved successfully', { correlationId });
    event.reply('settings', sanitizedSettings);
  } catch (error) {
    logger.error('Failed to load settings with secure credentials', {
      error: error.message,
      correlationId
    });

    // Return empty sanitized settings on error
    const emptySettings = {
      app: {},
      ui: {},
      integrations: {},
      searchSettings: {
        enableBM25Scoring: true,
        maxResults: 50,
        showRelevanceScores: false
      }
    };
    const sanitized = sanitizeSettingsForRenderer(emptySettings);

    event.reply('settings', sanitized);
  }
});

ipcMain.on('update-setting', async (event, key, value) => {
  const correlationId = generateCorrelationId();

  try {
    if (typeof key !== 'string') {
      logger.warn('Rejected update with non-string setting key', { key, type: typeof key, correlationId });
      event.reply('setting-error', key, 'Invalid setting key.');
      return;
    }

    // Check if key belongs to new config managers
    if (key.startsWith('app.')) {
      const appKey = key.substring(4); // Remove 'app.' prefix
      configs.app.set(appKey, value);
    } else if (key.startsWith('ui.')) {
      const uiKey = key.substring(3); // Remove 'ui.' prefix
      configs.ui.set(uiKey, value);
    } else if (ALLOWED_SETTING_KEYS.has(key)) {
      // Handle legacy settings while syncing with config managers
      let integrationId = null;
      let fieldKey = null;

      const keyParts = key.split('.');
      if (keyParts.length >= 3) {
        integrationId = keyParts[1];
        fieldKey = keyParts.slice(2).join('.');
      }

      const integrationManager = integrationId && configs.integrations
        ? configs.integrations[integrationId]
        : null;

      if (integrationManager && fieldKey) {
        try {
          if (value === undefined || value === null || value === '') {
            integrationManager.delete(fieldKey);
          } else {
            integrationManager.set(fieldKey, value);
          }
        } catch (configError) {
          logger.warn('Failed to sync integration setting to config manager', {
            integrationId,
            fieldKey,
            error: configError.message,
            correlationId
          });
        }
      }

      if (SENSITIVE_SETTING_KEYS.has(key)) {
        await setSecureSetting(key, value);
      } else {
        if (value === undefined || value === null) {
          store.delete(key);
        } else {
          store.set(key, value);
        }
      }
    } else {
      logger.warn('Rejected update for unsupported setting key', { key, correlationId });
      event.reply('setting-error', key, 'Unsupported setting field');
      return;
    }

    if (key === 'shortcut' || key === 'ui.hotkey') {
      const hotkey = key === 'ui.hotkey' ? value : configs.ui.get('hotkey', value);
      globalShortcut.unregisterAll();
      globalShortcut.register(hotkey, () => {
        logger.debug('Global shortcut triggered after update', { shortcut: value });
        createSearchWindow();
      });
      if (!globalShortcut.isRegistered(value)) {
        logger.error(`Failed to register updated global shortcut: ${value}`, { correlationId });
      }
    }

    if (key === 'launchOnStart') {
      if (value) {
        autoLauncher.enable().catch((err) => {
          logger.error('Failed to enable SearchSync auto-launch', {
            error: err.message,
            correlationId
          });
        });
      } else {
        autoLauncher.disable().catch((err) => {
          logger.error('Failed to disable SearchSync auto-launch', {
            error: err.message,
            correlationId
          });
        });
      }
    }

    logger.info('Setting updated successfully', { key, correlationId });
    event.reply('setting-updated', key, value);
  } catch (err) {
    logger.error(`Failed to update setting ${key}`, {
      error: err.message,
      key,
      value,
      correlationId
    });
    event.reply('setting-error', key, 'Could not update the requested setting.');
  }
});

// Handle external URL opening with click tracking
ipcMain.on('open-url', (event, url, resultData = null) => {
  try {
    const parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(`Unsupported protocol: ${parsedUrl.protocol}`);
    }

    shell.openExternal(parsedUrl.toString()).catch((error) => {
      logger.error('Failed to open external URL', { url, error: error.message });
      event.reply('open-url-error', 'Could not open the requested link.');
    });
  } catch (error) {
    logger.warn('Blocked attempt to open unsupported URL', { url, error: error.message });
    event.reply('open-url-error', 'This link type is not supported.');
    return;
  }
  
  // Update user context if result data is provided
  if (resultData) {
    try {
      const userContext = configs.app.get('userContext', {});
      const updatedContext = updateUserContext(userContext, resultData.query || '', resultData);
      configs.app.set('userContext', updatedContext);
    } catch (error) {
      logger.error('Failed to update user context after opening URL', { url, error: error.message });
    }
  }
});

// Handle show window request from tray
ipcMain.on('show-window', (event) => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createMainWindow();
  }
});

// Handle hide window request
ipcMain.on('hide-window', (event) => {
  if (mainWindow) {
    mainWindow.hide();
    if (!tray) createTray();
  }
});

for (const definition of Object.values(integrationRegistry)) {
  if (!definition.testEvent || typeof definition.testConnection !== 'function') {
    continue;
  }

  ipcMain.on(definition.testEvent, async (event, config = {}) => {
    const correlationId = generateCorrelationId();
    try {
      const preparedConfig = { ...config };

      if (Array.isArray(definition.sensitiveKeys) && definition.sensitiveKeys.length > 0) {
        for (const sensitiveKey of definition.sensitiveKeys) {
          const currentValue = preparedConfig[sensitiveKey];
          const isMasked = typeof currentValue === 'string' && currentValue.trim() === SENSITIVE_VALUE_MASK;
          const isMissing =
            currentValue === undefined ||
            currentValue === null ||
            (typeof currentValue === 'string' && currentValue.trim() === '');
          const isSentinelObject =
            currentValue && typeof currentValue === 'object' && currentValue.hasCredential !== undefined;

          if (isMasked || isMissing || isSentinelObject) {
            const storeKey = `integrations.${definition.id}.${sensitiveKey}`;
            const storedValue = await getSecureSetting(storeKey);

            if (storedValue) {
              preparedConfig[sensitiveKey] = storedValue;
            } else if (isMasked || isSentinelObject) {
              // Prevent validators/connectors from seeing placeholder values
              preparedConfig[sensitiveKey] = '';
            }
          }
        }
      }

      const validator = definition.validateTestConfig || definition.validateSearchConfig;
      if (typeof validator === 'function') {
        const validationMessage = validator(preparedConfig);
        if (validationMessage) {
          event.reply('test-result', {
            source: definition.sourceName,
            success: false,
            message: validationMessage
          });
          return;
        }
      }

      // Log sanitized config for security
      const sanitizedConfig = sanitizeTestConfig(preparedConfig, definition.id);
      logger.debug('Testing connection', {
        integration: definition.sourceName,
        config: sanitizedConfig,
        correlationId
      });

      const result = await definition.testConnection(preparedConfig);

      event.reply('test-result', {
        source: definition.sourceName,
        success: Boolean(result?.success),
        message: result?.message || 'Connection test completed.'
      });
    } catch (error) {
      logger.error('Connection test failed', {
        integration: definition.sourceName,
        error: error.message,
        correlationId
      });

      const formatted = typeof definition.formatTestError === 'function'
        ? definition.formatTestError(error)
        : (error?.message || 'Unknown error');

      event.reply('test-result', {
        source: definition.sourceName,
        success: false,
        message: formatted
      });
    }
  });
}

// -----------------------------------------------------------------------------
// Search Result Processing Implementation
// -----------------------------------------------------------------------------

/**
 * Sorts an array of results strictly by their 'updated' date, newest first.
 * Handles missing or invalid dates by pushing them to the end.
 * @param {Array} results - The array of search results.
 * @returns {Array} - The sorted array of results.
 */
function sortResultsByDate(results) {
  return results.sort((a, b) => {
    const dateA = a.updated ? new Date(a.updated) : null;
    const dateB = b.updated ? new Date(b.updated) : null;

    // Handle invalid dates: push them to the bottom
    const isValidA = dateA && !isNaN(dateA);
    const isValidB = dateB && !isNaN(dateB);

    if (isValidA && isValidB) {
      return dateB.getTime() - dateA.getTime(); // Sort descending (newest first)
    } else if (isValidA) {
      return -1; // A is valid, B is not -> A comes first
    } else if (isValidB) {
      return 1; // B is valid, A is not -> B comes first
    } else {
      return 0; // Both invalid, maintain relative order (or consider title sort as fallback)
    }
  });
}
