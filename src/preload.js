const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld(
  'api', {
      search: (query, activeFilters = []) => {
    ipcRenderer.send('search', query, activeFilters);
  },
    onSearchResults: (callback) => {
      ipcRenderer.on('search-results', (event, data) => callback(data));
    },
    getSettings: () => {
      ipcRenderer.send('get-settings');
    },
    onSettings: (callback) => {
      ipcRenderer.on('settings', (event, settings) => callback(settings));
    },
    updateSetting: (key, value) => {
      ipcRenderer.send('update-setting', key, value);
    },
    onSettingUpdated: (callback) => {
      ipcRenderer.on('setting-updated', (event, key, value) => callback(key, value));
    },
    onSettingError: (callback) => {
      ipcRenderer.on('setting-error', (event, key, message) => callback(key, message));
    },
    openUrl: (url, resultData = null) => {
      ipcRenderer.send('open-url', url, resultData);
    },
    onOpenUrlError: (callback) => {
      ipcRenderer.on('open-url-error', (event, message) => callback(message));
    },

    testJiraConnection: (config) => {
      ipcRenderer.send('test-jira-connection', config);
    },
    testAzureConnection: (config) => {
      ipcRenderer.send('test-azure-connection', config);
    },
    testConfluenceConnection: (config) => {
      ipcRenderer.send('test-confluence-connection', config);
    },
    testAsanaConnection: (config) => {
      ipcRenderer.send('test-asana-connection', config);
    },
    onTestResult: (callback) => {
      ipcRenderer.on('test-result', (event, result) => callback(result));
    },

    showWindow: () => {
      ipcRenderer.send('show-window');
    },
    hideWindow: () => {
      ipcRenderer.send('hide-window');
    },

  }
);
