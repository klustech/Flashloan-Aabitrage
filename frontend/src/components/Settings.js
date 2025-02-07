// frontend/src/components/Settings.js

import { Link } from 'react-router-dom';
import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './Settings.css'; // Ensure you have the corresponding CSS

const Settings = () => {
  const [settings, setSettings] = useState({
    ETH_AMOUNT_TO_SWAP: '0.05',
    SLIPPAGE_TOLERANCE: 5,
    GAS_PRICE_MULTIPLIER: 1.2,
    PROFIT_THRESHOLD: 10,
    DEADLINE_BUFFER: 60,
    MAX_GAS_PRICE: '200',
    TOKEN_WHITELIST: '',
    TOKEN_BLACKLIST: '',
    FLASHBOTS_ENABLED: false,
    // Updated field: this now represents the Base Token Reserve setting
    MIN_BASE_TOKEN_RESERVE: '50'
  });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch current settings from the backend.
  const fetchSettings = async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await axios.get('http://localhost:3001/api/settings');
      const fetchedSettings = response.data;

      setSettings({
        ETH_AMOUNT_TO_SWAP: fetchedSettings.ETH_AMOUNT_TO_SWAP || '0.05',
        SLIPPAGE_TOLERANCE: fetchedSettings.SLIPPAGE_TOLERANCE || 5,
        GAS_PRICE_MULTIPLIER: fetchedSettings.GAS_PRICE_MULTIPLIER || 1.2,
        PROFIT_THRESHOLD: fetchedSettings.PROFIT_THRESHOLD || 10,
        DEADLINE_BUFFER: fetchedSettings.DEADLINE_BUFFER || 60,
        MAX_GAS_PRICE: fetchedSettings.MAX_GAS_PRICE || '200',
        TOKEN_WHITELIST: Array.isArray(fetchedSettings.TOKEN_WHITELIST)
          ? fetchedSettings.TOKEN_WHITELIST.join(', ')
          : '',
        TOKEN_BLACKLIST: Array.isArray(fetchedSettings.TOKEN_BLACKLIST)
          ? fetchedSettings.TOKEN_BLACKLIST.join(', ')
          : '',
        FLASHBOTS_ENABLED: fetchedSettings.FLASHBOTS_ENABLED === true,
        MIN_BASE_TOKEN_RESERVE: fetchedSettings.MIN_BASE_TOKEN_RESERVE
          ? fetchedSettings.MIN_BASE_TOKEN_RESERVE.toString()
          : '50'
      });
    } catch (error) {
      console.error('Error fetching settings:', error);
      setError('Failed to fetch settings.');
    }
    setLoading(false);
  };

  // Send updated settings to the backend.
  const updateSettingsHandler = async () => {
    setLoading(true);
    setError(null);
    try {
      const updatedSettings = {
        ETH_AMOUNT_TO_SWAP: settings.ETH_AMOUNT_TO_SWAP,
        SLIPPAGE_TOLERANCE: parseFloat(settings.SLIPPAGE_TOLERANCE),
        GAS_PRICE_MULTIPLIER: parseFloat(settings.GAS_PRICE_MULTIPLIER),
        PROFIT_THRESHOLD: parseFloat(settings.PROFIT_THRESHOLD),
        DEADLINE_BUFFER: parseInt(settings.DEADLINE_BUFFER, 10),
        MAX_GAS_PRICE: settings.MAX_GAS_PRICE,
        TOKEN_WHITELIST: settings.TOKEN_WHITELIST
          ? settings.TOKEN_WHITELIST.split(',').map(addr => addr.trim())
          : [],
        TOKEN_BLACKLIST: settings.TOKEN_BLACKLIST
          ? settings.TOKEN_BLACKLIST.split(',').map(addr => addr.trim())
          : [],
        FLASHBOTS_ENABLED: settings.FLASHBOTS_ENABLED,
        MIN_BASE_TOKEN_RESERVE: parseFloat(settings.MIN_BASE_TOKEN_RESERVE)
      };

      await axios.post('http://localhost:3001/api/settings', updatedSettings);
      alert('Settings updated successfully!');
      fetchSettings();
    } catch (error) {
      console.error('Error updating settings:', error);
      setError('Failed to update settings.');
      alert('Failed to update settings.');
    }
    setLoading(false);
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  return (
    <div className="settings">
      <div className="navbar">
        <Link to="/">Dashboard</Link>
        <Link to="/trades">Trades</Link>
        <Link to="/settings">Settings</Link>
      </div>
      <h2>Settings</h2>

      {loading && <p>Loading...</p>}
      {error && <p className="error">{error}</p>}

      <form className="settings-form" onSubmit={e => e.preventDefault()}>
        <label className="label">
          ETH Amount to Swap:
          <input
            type="number"
            step="0.01"
            value={settings.ETH_AMOUNT_TO_SWAP}
            onChange={e => setSettings({ ...settings, ETH_AMOUNT_TO_SWAP: e.target.value })}
            className="input"
          />
        </label>

        <label className="label">
          Slippage Tolerance (%):
          <input
            type="number"
            value={settings.SLIPPAGE_TOLERANCE}
            onChange={e => setSettings({ ...settings, SLIPPAGE_TOLERANCE: e.target.value })}
            className="input"
          />
        </label>

        <label className="label">
          Gas Price Multiplier:
          <input
            type="number"
            step="0.1"
            value={settings.GAS_PRICE_MULTIPLIER}
            onChange={e => setSettings({ ...settings, GAS_PRICE_MULTIPLIER: e.target.value })}
            className="input"
          />
        </label>

        <label className="label">
          Profit Threshold (%):
          <input
            type="number"
            value={settings.PROFIT_THRESHOLD}
            onChange={e => setSettings({ ...settings, PROFIT_THRESHOLD: e.target.value })}
            className="input"
          />
        </label>

        <label className="label">
          Deadline Buffer (seconds):
          <input
            type="number"
            value={settings.DEADLINE_BUFFER}
            onChange={e => setSettings({ ...settings, DEADLINE_BUFFER: e.target.value })}
            className="input"
          />
        </label>

        {/* Updated field for Base Token Reserve */}
        <label className="label">
          Minimum Base Token Reserve (ETH):
          <input
            type="number"
            step="0.01"
            value={settings.MIN_BASE_TOKEN_RESERVE}
            onChange={e => setSettings({ ...settings, MIN_BASE_TOKEN_RESERVE: e.target.value })}
            className="input"
          />
        </label>

        <label className="label">
          Max Gas Price (Gwei):
          <input
            type="number"
            value={settings.MAX_GAS_PRICE}
            onChange={e => setSettings({ ...settings, MAX_GAS_PRICE: e.target.value })}
            className="input"
          />
        </label>

        <label className="label">
          Token Whitelist (comma-separated addresses):
          <input
            type="text"
            value={settings.TOKEN_WHITELIST}
            onChange={e => setSettings({ ...settings, TOKEN_WHITELIST: e.target.value })}
            className="input"
          />
        </label>

        <label className="label">
          Token Blacklist (comma-separated addresses):
          <input
            type="text"
            value={settings.TOKEN_BLACKLIST}
            onChange={e => setSettings({ ...settings, TOKEN_BLACKLIST: e.target.value })}
            className="input"
          />
        </label>

        <label className="label">
          Flashbots Enabled:
          <input
            type="checkbox"
            checked={settings.FLASHBOTS_ENABLED}
            onChange={e => setSettings({ ...settings, FLASHBOTS_ENABLED: e.target.checked })}
            className="input"
          />
        </label>

        <button className="button" onClick={updateSettingsHandler} disabled={loading}>
          {loading ? 'Updating...' : 'Update Settings'}
        </button>
      </form>
    </div>
  );
};

export default Settings;
