export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const VOCAL_SEPARATION_MODEL_REVISION = "927cd9272154b85c53518daf44063ee033ee22c3";
// Attention outputs are required for real word-level alignment. The plain
// whisper-small export cannot satisfy return_timestamps: "word".
export const AUTOMATIC_CAPTION_MODEL_ID = "onnx-community/whisper-small_timestamped";
export const AUTOMATIC_CAPTION_MODEL_REVISION = "65caa70f294b46e1c33ff820aae6b16d048ab818";

export const REMASTER_DRUNET_MODEL = {
  id: "seantempesta/remaster-drunet",
  label: "Remaster DRUNet Student",
  revision: "018e7815aa8ef6e3eb6433d2572433d4f36e180e",
  file: "drunet_student.onnx",
};

export const REMASTER_DRUNET_MODEL_URL =
  `https://huggingface.co/${REMASTER_DRUNET_MODEL.id}/resolve/${REMASTER_DRUNET_MODEL.revision}/${REMASTER_DRUNET_MODEL.file}`;
export const AUTOMATIC_CAPTION_MODEL_LABEL = "Whisper small";
export const YOLOS_TINY_MODEL_ID = "Xenova/yolos-tiny";
export const YOLOS_TINY_MODEL_LABEL = "YOLOS tiny";
export const YOLOS_TINY_MODEL_REVISION = "e2f9c7673f0fa61849efe2b56a0d7774779ebb9d";
export const MODNET_MODEL_ID = "Xenova/modnet";
export const MODNET_MODEL_LABEL = "MODNet";
export const MODNET_MODEL_REVISION = "fa2fa546052fba4c08921230a26cc69a333fca12";
