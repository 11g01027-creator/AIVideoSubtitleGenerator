import { GoogleGenAI } from "@google/genai";

// --- DOM Elements ---
const videoUploadInput = document.getElementById('video-upload') as HTMLInputElement;
const uploadContainer = document.getElementById('upload-container');
const videoContainer = document.getElementById('video-container');
const videoPlayer = document.getElementById('video-player') as HTMLVideoElement;
const generateButton = document.getElementById('generate-button') as HTMLButtonElement;
const cancelButton = document.getElementById('cancel-button') as HTMLButtonElement;
const statusText = document.getElementById('status-text');
const generationControls = document.getElementById('generation-controls');
const postGenerationControls = document.getElementById('post-generation-controls');
const downloadButton = document.getElementById('download-button') as HTMLButtonElement;
const resetButton = document.getElementById('reset-button') as HTMLButtonElement;

// --- State ---
let ai: GoogleGenAI;
let isGenerationCancelled = false;
let audioContext: AudioContext | null = null;
let generatedVttContent: string | null = null;
let currentFile: File | null = null;

/**
 * Initializes the GoogleGenAI client.
 */
function initializeAi() {
  try {
    ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  } catch (error) {
    console.error('Failed to initialize GoogleGenAI:', error);
    updateStatus('エラー: AIを初期化できませんでした。APIキーを確認してください。');
  }
}

/**
 * Updates the status text displayed to the user.
 */
function updateStatus(message: string) {
  if (statusText) {
    statusText.textContent = message;
  }
}

/**
 * Resets the application to its initial state.
 */
function resetApp() {
    if (videoPlayer.src) {
        URL.revokeObjectURL(videoPlayer.src);
        videoPlayer.removeAttribute('src');
    }
    const existingTracks = videoPlayer.querySelectorAll('track');
    existingTracks.forEach(track => track.remove());
    videoPlayer.load(); // Reload the video element to clear it

    uploadContainer?.classList.remove('hidden');
    videoContainer?.classList.add('hidden');
    
    postGenerationControls?.classList.add('hidden');
    generationControls?.classList.remove('hidden');
    generateButton.classList.remove('hidden');
    cancelButton.classList.add('hidden');
    generateButton.disabled = true;
    
    videoUploadInput.value = ''; // Allow re-uploading the same file
    videoUploadInput.disabled = false;
    
    generatedVttContent = null;
    currentFile = null;
    updateStatus('');
}

/**
 * Handles the video file selection.
 */
function handleVideoUpload(event: Event) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];

  if (file) {
    resetApp(); // Reset in case a video was already there
    
    currentFile = file;

    const fileURL = URL.createObjectURL(file);
    videoPlayer.src = fileURL;

    uploadContainer?.classList.add('hidden');
    videoContainer?.classList.remove('hidden');
    
    generateButton.disabled = false;
    updateStatus('ビデオが読み込まれました。「字幕を生成」ボタンを押してください。');
  }
}

/**
 * Formats seconds into a VTT timestamp string (HH:MM:SS.mmm).
 */
function formatTimeVTT(seconds: number): string {
    const date = new Date(0);
    date.setSeconds(seconds);
    return date.toISOString().substr(11, 12);
}

/**
 * Formats remaining time in seconds to a MM:SS string.
 */
function formatRemainingTime(seconds: number): string {
    if (isNaN(seconds) || seconds < 0 || !isFinite(seconds)) {
        return '--:--';
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    const formattedMinutes = String(minutes).padStart(2, '0');
    const formattedSeconds = String(remainingSeconds).padStart(2, '0');
    return `${formattedMinutes}:${formattedSeconds}`;
}

/**
 * Converts an AudioBuffer to a base64 encoded WAV string.
 */
function audioBufferToWavBase64(buffer: AudioBuffer): string {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArray = new ArrayBuffer(length);
  const view = new DataView(bufferArray);
  const channels = [];
  let i = 0;
  let sample = 0;
  let offset = 0;
  let pos = 0;

  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8);
  setUint32(0x45564157); // "WAVE"
  setUint32(0x20746d66); // "fmt "
  setUint32(16);
  setUint16(1);
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan);
  setUint16(numOfChan * 2);
  setUint16(16);
  setUint32(0x61746164); // "data"
  setUint32(length - pos - 4);

  function setUint16(data: number) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: number) {
    view.setUint32(pos, data, true);
    pos += 4;
  }

  for (i = 0; i < numOfChan; i++) {
    channels.push(buffer.getChannelData(i));
  }

  while (pos < length) {
    for (i = 0; i < numOfChan; i++) {
      sample = Math.max(-1, Math.min(1, channels[i][offset]));
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0;
      view.setInt16(pos, sample, true);
      pos += 2;
    }
    offset++;
  }

  const u8 = new Uint8Array(bufferArray);
  const CHUNK_SIZE = 0x8000;
  let binary = '';
  for (let i = 0; i < u8.length; i += CHUNK_SIZE) {
    const chunk = u8.subarray(i, i + CHUNK_SIZE);
    for (let j = 0; j < chunk.length; j++) {
      binary += String.fromCharCode(chunk[j]);
    }
  }
  return btoa(binary);
}

/**
 * Generates subtitles from audio by transcription.
 */
async function transcribeAudio(generationStartTime: number): Promise<string> {
    const file = currentFile;
    if (!file) throw new Error("ビデオファイルが見つかりません。");

    if (!audioContext) audioContext = new AudioContext();

    updateStatus('オーディオデータをデコード中...');
    const arrayBuffer = await file.arrayBuffer();
    const mainAudioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    
    const CHUNK_SECONDS = 30;
    const audioDuration = mainAudioBuffer.duration;
    let vttContent = "WEBVTT\n\n";
    const chunkCount = Math.ceil(audioDuration / CHUNK_SECONDS);

    for (let i = 0; i < audioDuration; i += CHUNK_SECONDS) {
        if (isGenerationCancelled) break;

        const startTime = i;
        const endTime = Math.min(i + CHUNK_SECONDS, audioDuration);
        const currentChunk = Math.floor(i / CHUNK_SECONDS) + 1;
        
        if (currentChunk > 1) {
            const elapsedTime = (Date.now() - generationStartTime) / 1000;
            const averageTimePerChunk = elapsedTime / (currentChunk - 1);
            const remainingChunks = chunkCount - (currentChunk - 1);
            const etrSeconds = averageTimePerChunk * remainingChunks;
            const formattedEtr = formatRemainingTime(etrSeconds);
            updateStatus(`音声から字幕を生成中... (チャンク ${currentChunk}/${chunkCount}) - 残り約${formattedEtr}`);
        } else {
            updateStatus(`音声から字幕を生成中... (チャンク ${currentChunk}/${chunkCount})`);
        }

        const frameCount = Math.ceil((endTime - startTime) * mainAudioBuffer.sampleRate);
        const startOffset = Math.floor(startTime * mainAudioBuffer.sampleRate);
        
        const chunkBuffer = audioContext.createBuffer(
            mainAudioBuffer.numberOfChannels,
            frameCount,
            mainAudioBuffer.sampleRate
        );

        for (let channel = 0; channel < mainAudioBuffer.numberOfChannels; channel++) {
            const channelData = mainAudioBuffer.getChannelData(channel);
            const chunkChannelData = chunkBuffer.getChannelData(channel);
            chunkChannelData.set(channelData.subarray(startOffset, startOffset + frameCount));
        }

        const base64Wav = audioBufferToWavBase64(chunkBuffer);
        const audioPart = { inlineData: { mimeType: 'audio/wav', data: base64Wav } };
        const textPart = { text: 'この音声を日本語で文字に書き起こしてください。' };

        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ parts: [audioPart, textPart] }],
        });
        
        const subtitleText = response.text.trim().replace(/\n/g, ' ');
        if (subtitleText) {
            vttContent += `${formatTimeVTT(startTime)} --> ${formatTimeVTT(endTime)}\n${subtitleText}\n\n`;
        }
    }
    return vttContent;
}

/**
 * Main function to start subtitle generation.
 */
async function generateSubtitles() {
  if (!ai) {
    updateStatus('AIが初期化されていません。');
    return;
  }

  isGenerationCancelled = false;
  generateButton.classList.add('hidden');
  cancelButton.classList.remove('hidden');
  cancelButton.disabled = false;
  videoUploadInput.disabled = true;

  updateStatus('字幕生成を開始します...');
  const generationStartTime = Date.now();
  let vttContent: string | null = null;

  try {
    vttContent = await transcribeAudio(generationStartTime);
  } catch (error) {
    console.error('Error generating subtitles:', error);
    updateStatus('エラーが発生しました。もう一度お試しください。');
  }

  if (isGenerationCancelled) {
    updateStatus('字幕生成をキャンセルしました。');
    generateButton.classList.remove('hidden');
    cancelButton.classList.add('hidden');
    videoUploadInput.disabled = false;
    return;
  }

  const hasSubtitles = vttContent && vttContent.length > "WEBVTT\n\n".length;

  if (hasSubtitles) {
    generatedVttContent = vttContent;
    const vttBlob = new Blob([vttContent], { type: 'text/vtt' });
    const vttUrl = URL.createObjectURL(vttBlob);

    const existingTracks = videoPlayer.querySelectorAll('track');
    existingTracks.forEach(track => track.remove());

    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = '日本語 (AI)';
    track.srclang = 'ja';
    track.src = vttUrl;
    track.default = true;
    videoPlayer.appendChild(track);

    if (videoPlayer.textTracks.length > 0) {
      videoPlayer.textTracks[0].mode = 'showing';
    }
    updateStatus('字幕の生成が完了しました！');
    generationControls?.classList.add('hidden');
    postGenerationControls?.classList.remove('hidden');
  } else {
    updateStatus(vttContent !== null ? '字幕を生成できませんでした。' : 'エラーが発生したか、キャンセルされました。');
    generateButton.classList.remove('hidden');
    cancelButton.classList.add('hidden');
    videoUploadInput.disabled = false;
  }
}

/**
 * Downloads the generated VTT subtitle file.
 */
function downloadVttFile() {
    if (!generatedVttContent) {
        updateStatus('ダウンロードする字幕ファイルがありません。');
        return;
    }

    const blob = new Blob([generatedVttContent], { type: 'text/vtt;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    
    const originalFileName = currentFile?.name ?? 'video';
    const baseName = originalFileName.substring(0, originalFileName.lastIndexOf('.') || originalFileName.length);
    a.download = `${baseName}.vtt`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

/**
 * Add event listeners when the document is ready.
 */
document.addEventListener('DOMContentLoaded', () => {
  videoUploadInput?.addEventListener('change', handleVideoUpload);
  generateButton?.addEventListener('click', generateSubtitles);
  downloadButton?.addEventListener('click', downloadVttFile);
  resetButton?.addEventListener('click', resetApp);
  
  cancelButton?.addEventListener('click', () => {
    isGenerationCancelled = true;
    cancelButton.disabled = true;
    updateStatus('キャンセル処理中...');
  });

  initializeAi();
});