// Debug log function
function debugLog(message, isError = false) {
  const logElement = document.getElementById('debug-log');
  const entry = document.createElement('div');
  entry.className = 'debug-log-entry';

  const time = document.createElement('span');
  time.className = 'debug-log-time';
  time.textContent = new Date().toLocaleTimeString();

  const messageElement = document.createElement('span');
  messageElement.className = isError ? 'debug-log-message debug-log-error' : 'debug-log-message';
  messageElement.textContent = message;

  entry.appendChild(time);
  entry.appendChild(messageElement);
  logElement.appendChild(entry);

  // Scroll to bottom
  logElement.scrollTop = logElement.scrollHeight;

  // Also log to console
  if (isError) {
    console.error(message);
  }
}

// Function to validate a shortcut
function isValidShortcut(shortcut) {
  // Must have at least one modifier (Ctrl, Alt, Shift, Command) and one key
  const modifiers = ['Control', 'CommandOrControl', 'Ctrl', 'Alt', 'Option', 'Shift', 'Super', 'Command'];
  let hasModifier = false;

  for (const modifier of modifiers) {
    if (shortcut.includes(modifier)) {
      hasModifier = true;
      break;
    }
  }

  // Check if it has more than just modifiers (at least one regular key)
  const parts = shortcut.split('+');
  let hasRegularKey = false;

  for (const part of parts) {
    if (!modifiers.includes(part)) {
      hasRegularKey = true;
      break;
    }
  }

  return hasModifier && hasRegularKey && parts.length >= 2;
}

// Function to format a shortcut according to Electron's accelerator format
function formatShortcut(shortcut) {
  // Ensure proper format for Electron accelerators
  // Replace Command with CommandOrControl for cross-platform compatibility
  let formatted = shortcut.replace('Command', 'CommandOrControl');

  // Ensure proper capitalization for special keys
  const specialKeys = ['CommandOrControl', 'Control', 'Ctrl', 'Alt', 'Option', 'Shift', 'Super', 'Space', 'Tab', 'Backspace', 'Delete', 'Insert', 'Return', 'Enter', 'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown', 'Escape', 'Esc', 'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'MediaPlayPause', 'PrintScreen'];

  specialKeys.forEach(key => {
    const regex = new RegExp(key, 'i');
    if (formatted.match(regex)) {
      formatted = formatted.replace(regex, key);
    }
  });

  return formatted;
}

// Shortcut recording functionality
let isRecording = false;
const recordButton = document.getElementById('record-shortcut');
const shortcutInput = document.getElementById('shortcut');
const shortcutHelp = document.getElementById('shortcut-help');

const listenersState = { initialized: false };

function getElement(id) {
  return document.getElementById(id);
}

function getElementValue(id) {
  const element = getElement(id);
  if (!element) return '';
  if (element.type === 'checkbox') {
    return element.checked;
  }
  return element.value;
}

const integrationUIConfig = [
  {
    id: 'jira',
    source: 'Jira',
    fields: [
      { elementId: 'jira-enabled', key: 'enabled', type: 'checkbox' },
      { elementId: 'jira-base-url', key: 'baseUrl' },
      { elementId: 'jira-email', key: 'email' },
      { elementId: 'jira-api-token', key: 'apiToken' },
      { elementId: 'jira-search-shortcut', key: 'searchShortcut', fallbackValue: 'jsd' },
      { elementId: 'jira-product-type', key: 'productType', fallbackValue: 'jira' }
    ],
    test: {
      buttonId: 'test-jira',
      resultElementId: 'jira-test-result',
      ipcMethod: 'testJiraConnection',
      buildConfig: () => ({
        baseUrl: getElementValue('jira-base-url'),
        email: getElementValue('jira-email'),
        apiToken: getElementValue('jira-api-token'),
        productType: getElementValue('jira-product-type') || 'jira'
      }),
      logMessage: (config) => `Testing Jira connection with URL: ${config.baseUrl}`
    }
  },
  {
    id: 'azureDevops',
    source: 'Azure DevOps',
    fields: [
      { elementId: 'azure-enabled', key: 'enabled', type: 'checkbox' },
      { elementId: 'azure-organization', key: 'organization' },
      { elementId: 'azure-project', key: 'project' },
      { elementId: 'azure-token', key: 'personalAccessToken' },
      { elementId: 'azure-search-shortcut', key: 'searchShortcut', fallbackValue: 'ado' }
    ],
    test: {
      buttonId: 'test-azure',
      resultElementId: 'azure-test-result',
      ipcMethod: 'testAzureConnection',
      buildConfig: () => ({
        organization: getElementValue('azure-organization'),
        project: getElementValue('azure-project'),
        personalAccessToken: getElementValue('azure-token')
      }),
      logMessage: (config) => `Testing Azure DevOps connection with org: ${config.organization}, project: ${config.project}`
    }
  },
  {
    id: 'confluence',
    source: 'Confluence',
    fields: [
      { elementId: 'confluence-enabled', key: 'enabled', type: 'checkbox' },
      { elementId: 'confluence-base-url', key: 'baseUrl' },
      { elementId: 'confluence-email', key: 'email' },
      { elementId: 'confluence-api-token', key: 'apiToken' },
      { elementId: 'confluence-space', key: 'space' },
      { elementId: 'confluence-search-shortcut', key: 'searchShortcut', fallbackValue: 'con' }
    ],
    test: {
      buttonId: 'test-confluence',
      resultElementId: 'confluence-test-result',
      ipcMethod: 'testConfluenceConnection',
      buildConfig: () => ({
        baseUrl: getElementValue('confluence-base-url'),
        email: getElementValue('confluence-email'),
        apiToken: getElementValue('confluence-api-token'),
        space: getElementValue('confluence-space')
      }),
      logMessage: (config) => `Testing Confluence connection with URL: ${config.baseUrl}`
    }
  },
  {
    id: 'asana',
    source: 'Asana',
    fields: [
      { elementId: 'asana-enabled', key: 'enabled', type: 'checkbox' },
      { elementId: 'asana-token', key: 'personalAccessToken' },
      { elementId: 'asana-workspace', key: 'workspace' },
      { elementId: 'asana-project', key: 'project' },
      { elementId: 'asana-search-shortcut', key: 'searchShortcut', fallbackValue: 'as' }
    ],
    test: {
      buttonId: 'test-asana',
      resultElementId: 'asana-test-result',
      ipcMethod: 'testAsanaConnection',
      buildConfig: () => ({
        personalAccessToken: getElementValue('asana-token'),
        workspace: getElementValue('asana-workspace'),
        project: getElementValue('asana-project')
      }),
      logMessage: () => 'Testing Asana connection with PAT: ***'
    }
  }
];

const SENSITIVE_VALUE_MASK = '••••••••';

// Function to start recording keyboard shortcuts
function startRecording() {
  isRecording = true;
  recordButton.textContent = 'Cancel';
  recordButton.classList.add('recording');
  shortcutInput.classList.add('recording-active');
  shortcutInput.value = 'Press keys...';
  shortcutHelp.textContent = 'Press the key combination you want to use';
  debugLog('Shortcut recording started');
}

// Function to stop recording keyboard shortcuts
function stopRecording() {
  isRecording = false;
  recordButton.textContent = 'Record';
  recordButton.classList.remove('recording');
  shortcutInput.classList.remove('recording-active');
  shortcutHelp.textContent = 'Click \'Record\' to set a new keyboard shortcut.';
  debugLog('Shortcut recording stopped');
}

// Handle record button click
recordButton.addEventListener('click', () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

// Handle keydown events when recording
document.addEventListener('keydown', (event) => {
  if (!isRecording) return;

  // Prevent default behavior for all keys during recording
  event.preventDefault();

  // Get the key combination
  const keys = [];

  if (event.ctrlKey) keys.push('Control');
  if (event.metaKey) keys.push('Command');
  if (event.altKey) keys.push('Alt');
  if (event.shiftKey) keys.push('Shift');

  // Add the main key if it's not a modifier
  if (!['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) {
    // Format the key name properly
    let keyName = event.key;

    // Handle special keys
    if (keyName === ' ') keyName = 'Space';
    else if (keyName.length === 1) keyName = keyName.toUpperCase();
    else keyName = keyName.charAt(0).toUpperCase() + keyName.slice(1);

    keys.push(keyName);
  }

  // Only process if we have at least one modifier and one regular key
  if (keys.length >= 2 && !['Control', 'Command', 'Alt', 'Shift'].includes(keys[keys.length - 1])) {
    // Format for Electron's accelerator format
    let shortcut = keys.join('+');
    shortcut = formatShortcut(shortcut);

    // Update the input field
    shortcutInput.value = shortcut;
    debugLog(`Shortcut recorded: ${shortcut}`);

    // Update the setting
    updateSetting('shortcut', shortcut);

    // Stop recording
    stopRecording();
  }
});

// Load settings when the page loads
window.onload = () => {
  debugLog('Page loaded, requesting settings...');
  try {
    // Get app settings
    window.api.getSettings();

    // Setup form listeners after a short delay to ensure all elements are loaded
    setTimeout(() => {
      setupFormListeners();
      // Wire API token help links
      try {
        const jiraTokenLink = document.getElementById('jira-token-link');
        if (jiraTokenLink) {
          jiraTokenLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.api.openUrl('https://id.atlassian.com/manage-profile/security/api-tokens');
          });
        }

        const confluenceTokenLink = document.getElementById('confluence-token-link');
        if (confluenceTokenLink) {
          confluenceTokenLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.api.openUrl('https://id.atlassian.com/manage-profile/security/api-tokens');
          });
        }

        const azureTokenLink = document.getElementById('azure-token-link');
        if (azureTokenLink) {
          azureTokenLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.api.openUrl('https://dev.azure.com/Blueshift/_usersSettings/tokens');
          });
        }

        const asanaTokenLink = document.getElementById('asana-token-link');
        if (asanaTokenLink) {
          asanaTokenLink.addEventListener('click', (e) => {
            e.preventDefault();
            window.api.openUrl('https://app.asana.com/0/my-apps');
          });
        }
      } catch (linkErr) {
        debugLog(`Error wiring token links: ${linkErr.message}`, true);
      }
      debugLog('Form listeners set up');
    }, 500);
  } catch (error) {
    debugLog(`Error requesting settings: ${error.message}`, true);
  }
};

// Handle settings data
function applyIntegrationSettings(settings) {
  const integrationSettings = settings.integrations || {};

  integrationUIConfig.forEach((integration) => {
    const currentSettings = integrationSettings[integration.id] || {};

    integration.fields.forEach((field) => {
      const element = getElement(field.elementId);
      if (!element) return;

      let value = currentSettings[field.key];
      if (value === undefined && field.fallbackValue !== undefined) {
        value = field.fallbackValue;
      }

      if (field.type === 'checkbox') {
        element.checked = Boolean(value);
      } else {
        const isSensitiveField = field.key === 'apiToken' || field.key === 'personalAccessToken';

        if (isSensitiveField) {
          const hasCredential = Boolean(value && value.hasCredential);

          if (hasCredential) {
            element.value = SENSITIVE_VALUE_MASK;
            element.dataset.masked = 'true';
          } else {
            element.value = '';
            delete element.dataset.masked;
          }
        } else {
          element.value = value ?? '';
        }
      }
    });
  });
}

window.api.onSettings((settings) => {
  debugLog('Settings received');
  try {
    // Cache settings for credential field handling
    window.cachedSettings = settings;

    document.getElementById('shortcut').value = settings.shortcut;
    document.getElementById('minimize-to-tray').checked = settings.minimizeToTray;
    document.getElementById('launch-on-start').checked = settings.launchOnStart;

    applyIntegrationSettings(settings);
  } catch (error) {
    debugLog(`Error applying settings: ${error.message}`, true);
  }
});

// Function to update a setting
function updateSetting(key, value) {
  debugLog(`Updating setting: ${key}`);
  try {
    window.api.updateSetting(key, value);

    // Show a temporary status message
    const statusElement = document.getElementById('status');
    statusElement.textContent = 'Setting updated';
    statusElement.className = 'status success';
    statusElement.style.display = 'block';

    setTimeout(() => {
      statusElement.style.display = 'none';
    }, 2000);
  } catch (error) {
    debugLog(`Error updating setting: ${error.message}`, true);
  }
}

// Handle setting updated event
window.api.onSettingUpdated((key, value) => {
  debugLog(`Setting updated: ${key}`);

  window.cachedSettings = window.cachedSettings || { integrations: {} };

  if (key.startsWith('integrations.')) {
    const parts = key.split('.');
    const integrationId = parts[1];
    const fieldKey = parts.slice(2).join('.');

    if (integrationId && fieldKey) {
      window.cachedSettings.integrations = window.cachedSettings.integrations || {};
      window.cachedSettings.integrations[integrationId] = window.cachedSettings.integrations[integrationId] || {};

      if (fieldKey === 'apiToken' || fieldKey === 'personalAccessToken') {
        window.cachedSettings.integrations[integrationId][fieldKey] = {
          hasCredential: Boolean(value && value.length > 0)
        };
      } else {
        window.cachedSettings.integrations[integrationId][fieldKey] = value;
      }
    }
  } else if (key.startsWith('app.')) {
    const appKey = key.substring(4);
    window.cachedSettings.app = window.cachedSettings.app || {};
    window.cachedSettings.app[appKey] = value;
  } else if (key.startsWith('ui.')) {
    const uiKey = key.substring(3);
    window.cachedSettings.ui = window.cachedSettings.ui || {};
    window.cachedSettings.ui[uiKey] = value;
  } else if (key === 'shortcut') {
    window.cachedSettings.shortcut = value;
  } else if (key === 'minimizeToTray') {
    window.cachedSettings.minimizeToTray = value;
  } else if (key === 'launchOnStart') {
    window.cachedSettings.launchOnStart = value;
  }
});

window.api.onSettingError((key, message) => {
  debugLog(`Setting update failed for ${key}: ${message}`, true);
  const statusElement = document.getElementById('status');
  statusElement.textContent = message || `Failed to update setting: ${key}`;
  statusElement.className = 'status error';
  statusElement.style.display = 'block';
  setTimeout(() => {
    statusElement.style.display = 'none';
  }, 4000);
});

// Add event listeners to all form elements
function setupFormListeners() {
  if (listenersState.initialized) return;

  // Shortcut input is handled separately with the record button

  const minimizeToTray = getElement('minimize-to-tray');
  if (minimizeToTray) {
    minimizeToTray.addEventListener('change', (event) => {
      updateSetting('minimizeToTray', event.target.checked);
    });
  }

  const launchOnStart = getElement('launch-on-start');
  if (launchOnStart) {
    launchOnStart.addEventListener('change', (event) => {
      updateSetting('launchOnStart', event.target.checked);
    });
  }

  integrationUIConfig.forEach((integration) => {
    integration.fields.forEach((field) => {
      const element = getElement(field.elementId);
      if (!element) return;

      const eventName = field.event || 'change';
      const isSensitiveField = field.key === 'apiToken' || field.key === 'personalAccessToken';

      if (isSensitiveField) {
        element.addEventListener('focus', () => {
          if (element.dataset.masked === 'true') {
            element.value = '';
            element.dataset.masked = 'editing';
          }
        });

        element.addEventListener('blur', () => {
          if (element.dataset.masked === 'editing' && element.value === '') {
            element.dataset.masked = 'true';
            element.value = SENSITIVE_VALUE_MASK;
          }
        });
      }

      const handler = (event) => {
        let value;
        if (typeof field.getValue === 'function') {
          value = field.getValue(event, element);
        } else if (field.type === 'checkbox') {
          value = element.checked;
        } else {
          if (element.tagName === 'SELECT') {
            value = element.value;
          } else {
            value = element.value;
          }
        }

        // Special handling for credential fields - don't update with empty values
        // This prevents clearing existing credentials when the field is loaded empty
        if (isSensitiveField) {
          const settings = window.cachedSettings || {};
          const currentValue = settings.integrations?.[integration.id]?.[field.key];
          const hadCredential = Boolean(currentValue && currentValue.hasCredential);

          if ((value === '' || value === SENSITIVE_VALUE_MASK) && element.dataset.masked === 'editing') {
            if (hadCredential) {
              debugLog(`Skipping empty credential update for ${field.key} - existing credential would be preserved`);
              element.dataset.masked = 'true';
              element.value = SENSITIVE_VALUE_MASK;
              return;
            }
          }

          if (value === SENSITIVE_VALUE_MASK) {
            // User didn't change the value; restore mask and exit
            element.dataset.masked = 'true';
            element.value = SENSITIVE_VALUE_MASK;
            return;
          }

          if (value === '' && hadCredential && event.type === 'change') {
            debugLog(`Skipping implicit credential clear for ${field.key}`);
            element.dataset.masked = 'true';
            element.value = SENSITIVE_VALUE_MASK;
            return;
          }
        }

        updateSetting(`integrations.${integration.id}.${field.key}`, value);

        if (isSensitiveField) {
          element.dataset.masked = value ? 'true' : '';
          element.value = value ? SENSITIVE_VALUE_MASK : '';

          // Keep cached settings in sync so subsequent edits behave correctly
          window.cachedSettings = window.cachedSettings || { integrations: {} };
          window.cachedSettings.integrations = window.cachedSettings.integrations || {};
          window.cachedSettings.integrations[integration.id] = window.cachedSettings.integrations[integration.id] || {};
          window.cachedSettings.integrations[integration.id][field.key] = {
            hasCredential: Boolean(value)
          };
        }
      };

      element.addEventListener(eventName, handler);

      const saveButton = getElement(`${field.elementId}-save`);
      if (saveButton) {
        saveButton.addEventListener('click', () => {
          handler({ type: 'click' });
        });
      }
    });

    if (integration.test) {
      const button = getElement(integration.test.buttonId);
      const resultElement = getElement(integration.test.resultElementId);

      if (button && resultElement) {
        button.addEventListener('click', () => {
          try {
            resultElement.textContent = 'Testing...';
            resultElement.className = 'test-result testing';

            const config = integration.test.buildConfig();
            if (typeof integration.test.logMessage === 'function') {
              debugLog(integration.test.logMessage(config));
            }

            const methodName = integration.test.ipcMethod;
            if (methodName && typeof window.api[methodName] === 'function') {
              window.api[methodName](config);
            } else {
              throw new Error(`Unsupported test method: ${methodName}`);
            }
          } catch (error) {
            debugLog(`Error testing ${integration.source} connection: ${error.message}`, true);
          }
        });
      }
    }
  });

  listenersState.initialized = true;
}
// Handle test results
window.api.onTestResult((data) => {
  debugLog(`Received test result: ${JSON.stringify(data)}`);
  try {
    const { source, success, message } = data;
    const integration = integrationUIConfig.find((item) => item.source === source);

    if (!integration || !integration.test) {
      debugLog(`No UI configuration found for test source: ${source}`, true);
      return;
    }

    const resultElement = getElement(integration.test.resultElementId);
    if (!resultElement) {
      debugLog(`Missing result element for ${source}`, true);
      return;
    }

    resultElement.textContent = message || (success ? 'Connection successful!' : 'Connection failed.');
    resultElement.className = `test-result ${success ? 'success' : 'error'}`;
  } catch (error) {
    debugLog(`Error handling test result: ${error.message}`, true);
  }
});