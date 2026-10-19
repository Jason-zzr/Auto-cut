import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeVoiceId } from "../config/editor.js";
import {
  deleteVoiceProfile, listVoiceProfiles, loadFavoriteBuiltInVoiceIds,
  saveFavoriteBuiltInVoiceIds, saveVoiceProfile, setVoiceProfileFavorite,
} from "../lib/voiceProfileStorage.js";

export function useVoiceProfiles({ favoriteVoiceIds, setFavoriteVoiceIds, notify, t }) {
  const [voiceProfiles, setVoiceProfiles] = useState([]);
  const [selectedVoiceProfileId, setSelectedVoiceProfileId] = useState("");
  const [voiceLibraryReady, setVoiceLibraryReady] = useState(false);
  const initialFavoriteVoiceIdsRef = useRef(favoriteVoiceIds);

  useEffect(() => {
    let active = true;
    Promise.all([listVoiceProfiles(), loadFavoriteBuiltInVoiceIds(initialFavoriteVoiceIdsRef.current)])
      .then(([profiles, favorites]) => {
        if (!active) return;
        setVoiceProfiles(profiles);
        setFavoriteVoiceIds([...new Set(favorites.map(normalizeVoiceId))]);
        setVoiceLibraryReady(true);
      })
      .catch((error) => { console.error(error); if (active) setVoiceLibraryReady(true); });
    return () => { active = false; };
  }, [setFavoriteVoiceIds]); // IndexedDB is loaded once for the editor session.

  useEffect(() => {
    if (!voiceLibraryReady) return;
    saveFavoriteBuiltInVoiceIds(favoriteVoiceIds).catch(console.error);
  }, [favoriteVoiceIds, voiceLibraryReady]);

  const addVoiceProfile = useCallback(async (profile) => {
    await saveVoiceProfile(profile); setVoiceProfiles((items) => [profile, ...items.filter((item) => item.id !== profile.id)]);
    return profile;
  }, []);
  const removeVoiceProfile = useCallback(async (profileId) => {
    await deleteVoiceProfile(profileId); setVoiceProfiles((items) => items.filter((item) => item.id !== profileId));
    setSelectedVoiceProfileId((current) => current === profileId ? "" : current); notify(t("cloneVoiceDeleted", "声音档案已删除"));
  }, [notify, t]);
  const toggleVoiceProfileFavorite = useCallback(async (profileId, favorite) => {
    const current = voiceProfiles.find((item) => item.id === profileId); if (!current) return;
    const updated = await setVoiceProfileFavorite(profileId, favorite === undefined ? !current.favorite : favorite);
    if (updated) setVoiceProfiles((items) => items.map((item) => item.id === profileId ? updated : item));
  }, [voiceProfiles]);

  return { addVoiceProfile, removeVoiceProfile, selectedVoiceProfileId, setSelectedVoiceProfileId,
    toggleVoiceProfileFavorite, voiceLibraryReady, voiceProfiles };
}
