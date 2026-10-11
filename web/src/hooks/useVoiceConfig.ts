/**
 * What the server says voice can do, and the settings this browser has chosen.
 *
 * Fetched once. The status is a probe of the speech service, so it is a snapshot — if the
 * service comes up later, reloading the page is what notices, which is cheaper and less
 * surprising than a status that flips under you mid-conversation.
 */
import { useEffect, useState } from "react";

import type { VoiceStatus } from "../lib/types.ts";
import type { VoiceSettings } from "../lib/voiceSettings.ts";

import { api } from "../lib/api.ts";
import { resolveVoiceSettings } from "../lib/voiceSettings.ts";

export interface VoiceConfig {
  settings: VoiceSettings;
  status: null | VoiceStatus;
}

const FALLBACK: VoiceSettings = { aliases: "", soundsAlike: true, timeoutSeconds: 20, wakeWord: "Gianna" };

export const useVoiceConfig = (): VoiceConfig => {
  const [status, setStatus] = useState<null | VoiceStatus>(null);
  const [settings, setSettings] = useState<VoiceSettings>(FALLBACK);

  useEffect(() => {
    void api
      .voiceStatus()
      .then((s) => {
        setStatus(s);
        setSettings(resolveVoiceSettings(s.defaults));
      })
      .catch(() => setStatus(null));
  }, []);

  return { settings, status };
};
