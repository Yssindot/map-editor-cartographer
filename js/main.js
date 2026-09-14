import { state, bindHooks } from './state.js';
import { AUTOSAVE_KEY } from './constants.js';
import { generateMap, centerCamera, applyFullState, ensureFactionCodes, updateHistoryButtons, refreshPathUi } from './domain.js';
import { render, resizeCanvas, updateInspector } from './render.js';
import {
  loadSettings, syncFactionBrushInputs, syncCultureColorInput, syncRegionBrushInputs,
  refreshFactionList, refreshLoyaltyList, refreshControllerList,
  refreshCultureList, refreshRegionList, refreshRouteList,
  updateToolVisibility, refreshInteractionUI,
  refreshSelectedHexPanel, rebuildTerrainColors, rebuildTerrainSwatches,
  syncRouteSwatches, syncBgInputs, setActiveTool,
  refreshBuildingUi,
  closeFactionEditor, openModal
} from './ui.js';

bindHooks({
  render,
  refreshFactionList,
  refreshLoyaltyList,
  refreshControllerList,
  refreshCultureList,
  refreshRegionList,
  refreshRouteList,
  refreshSelectedHexPanel,
  refreshPathUi,
  refreshInteractionUI,
  updateHistoryButtons,
  syncRouteSwatches,
  syncBgInputs,
  updateInspector,
  rebuildTerrainColors,
  rebuildTerrainSwatches,
  syncFactionBrushInputs,
  syncRegionBrushInputs,
  syncCultureColorInput,
  updateToolVisibility,
  setActiveTool,
  closeFactionEditor,
  openModal,
  refreshBuildingUi
});

function init(){
  resizeCanvas();
  loadSettings();
  generateMap(state.mapCols, state.mapRows);

  const autosaveRaw = localStorage.getItem(AUTOSAVE_KEY);
  if (autosaveRaw) {
    const restore = state.prefPromptRestore ? confirm('Restore your previous session?') : true;
    if (restore) {
      try {
        applyFullState(JSON.parse(autosaveRaw));
      } catch (_) {
        alert('Failed to restore the previous session.');
      }
    }
  }

  ensureFactionCodes();
  centerCamera();
  syncFactionBrushInputs();
  syncCultureColorInput();
  refreshFactionList();
  refreshLoyaltyList();
  refreshControllerList();
  refreshCultureList();
  refreshRegionList();
  refreshRouteList();
  updateToolVisibility();
  refreshInteractionUI();
  updateHistoryButtons();
  refreshSelectedHexPanel();
  refreshBuildingUi();
  render();
  lucide.createIcons();
}

init();
