import React, { useEffect, useRef, useState, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Blob } from '@google/genai';
import { LIVE_MODEL } from '../constants';
import { addLog } from '../services/storageService';
import { decryptMessage } from '../utils/security';

interface VoiceInterfaceProps {
  apiKey: string;
  onClose: () => void;
  isActive: boolean;
}

// Audio Utils
function createBlob(data: Float32Array): Blob {
  const l = data.length;
  const int16 = new Int16Array(l);
  for (let i = 0; i < l; i++) {
    int16[i] = data[i] * 32768;
  }
  return {
    data: encode(new Uint8Array(int16.buffer)),
    mimeType: 'audio/pcm;rate=16000',
  };
}

function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const VoiceInterface: React.FC<VoiceInterfaceProps> = ({ apiKey, onClose, isActive }) => {
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error' | 'disconnected'>('connecting');
  const [transcription, setTranscription] = useState<string>('');
  
  // Refs for audio handling
  const nextStartTime = useRef<number>(0);
  const inputAudioContext = useRef<AudioContext | null>(null);
  const outputAudioContext = useRef<AudioContext | null>(null);
  const inputNode = useRef<GainNode | null>(null);
  const outputNode = useRef<GainNode | null>(null);
  const sources = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const sessionRef = useRef<any>(null); // Type 'any' for the session due to complexity of LiveSession type

  const cleanup = useCallback(() => {
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (inputAudioContext.current) {
      inputAudioContext.current.close();
      inputAudioContext.current = null;
    }
    if (outputAudioContext.current) {
      outputAudioContext.current.close();
      outputAudioContext.current = null;
    }
    if (sessionRef.current) {
       // Try closing if method exists
       try { sessionRef.current.close(); } catch(e) {}
       sessionRef.current = null;
    }
    sources.current.forEach(source => source.stop());
    sources.current.clear();
  }, []);

  useEffect(() => {
    if (!isActive) return;

    const startSession = async () => {
      try {
        setStatus('connecting');
        const ai = new GoogleGenAI({ apiKey });

        inputAudioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        outputAudioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        
        inputNode.current = inputAudioContext.current.createGain();
        outputNode.current = outputAudioContext.current.createGain();
        outputNode.current.connect(outputAudioContext.current.destination);

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;

        // Establish Connection
        const sessionPromise = ai.live.connect({
          model: LIVE_MODEL,
          callbacks: {
            onopen: () => {
              setStatus('connected');
              addLog('VOICE_CALL_START', 'Secure voice channel established', 'info');
              
              if (!inputAudioContext.current || !streamRef.current) return;

              const source = inputAudioContext.current.createMediaStreamSource(streamRef.current);
              const processor = inputAudioContext.current.createScriptProcessor(4096, 1, 1);
              scriptProcessorRef.current = processor;

              processor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                const pcmBlob = createBlob(inputData);
                sessionPromise.then(session => {
                  session.sendRealtimeInput({ media: pcmBlob });
                });
              };

              source.connect(processor);
              processor.connect(inputAudioContext.current.destination);
            },
            onmessage: async (message: LiveServerMessage) => {
              // Handle Transcription
              if (message.serverContent?.modelTurn?.parts[0]?.text) {
                 setTranscription(prev => message.serverContent?.modelTurn?.parts[0]?.text || '');
              }
              
              // Handle Audio
              const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
              if (base64Audio && outputAudioContext.current && outputNode.current) {
                 const ctx = outputAudioContext.current;
                 nextStartTime.current = Math.max(nextStartTime.current, ctx.currentTime);
                 
                 const audioBuffer = await decodeAudioData(
                   decode(base64Audio),
                   ctx,
                   24000,
                   1
                 );
                 
                 const source = ctx.createBufferSource();
                 source.buffer = audioBuffer;
                 source.connect(outputNode.current);
                 source.addEventListener('ended', () => {
                    sources.current.delete(source);
                 });
                 source.start(nextStartTime.current);
                 nextStartTime.current += audioBuffer.duration;
                 sources.current.add(source);
              }
              
              // Handle Interruption
              if (message.serverContent?.interrupted) {
                sources.current.forEach(s => s.stop());
                sources.current.clear();
                nextStartTime.current = 0;
              }
            },
            onclose: () => {
              setStatus('disconnected');
              addLog('VOICE_CALL_END', 'Secure voice channel closed', 'info');
            },
            onerror: (e) => {
              console.error(e);
              setStatus('error');
              addLog('VOICE_CALL_ERROR', 'Connection error occurred', 'warning');
            }
          },
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
            },
            systemInstruction: 'You are a secure communication AI assistant. Speak concisely and professionally.',
          }
        });

        // Store session promise wrapper if needed, but we mostly rely on closure
        // Just mocking the ref assignment for cleanup logic if needed
        sessionPromise.then(s => sessionRef.current = s);

      } catch (err) {
        console.error("Failed to start voice:", err);
        setStatus('error');
      }
    };

    startSession();

    return () => {
      cleanup();
    };
  }, [isActive, apiKey, cleanup]);

  if (!isActive) return null;

  return (
    <div className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center backdrop-blur-sm">
      <div className="bg-gray-800 p-8 rounded-2xl border border-primary-dark shadow-[0_0_50px_rgba(59,130,246,0.3)] w-full max-w-md text-center">
        <h3 className="text-2xl font-bold mb-6 text-primary tracking-widest uppercase">Secure Voice Link</h3>
        
        <div className="relative w-32 h-32 mx-auto mb-8 flex items-center justify-center">
           {/* Visualizer Ring */}
           <div className={`absolute inset-0 rounded-full border-4 border-primary/30 ${status === 'connected' ? 'animate-ping' : ''}`}></div>
           <div className={`w-24 h-24 rounded-full bg-gray-900 border-2 border-primary flex items-center justify-center relative z-10 overflow-hidden`}>
              {status === 'connecting' && <span className="text-xs text-yellow-500 animate-pulse">CONNECTING</span>}
              {status === 'connected' && <div className="w-16 h-1 bg-primary animate-pulse-slow shadow-[0_0_15px_#3b82f6]"></div>}
              {status === 'error' && <span className="text-xs text-red-500">ERROR</span>}
           </div>
        </div>

        <div className="text-gray-400 mb-8 h-6 text-sm font-mono">
           {status === 'connected' ? "ENCRYPTED CHANNEL ACTIVE // BIDIRECTIONAL" : "ESTABLISHING HANDSHAKE..."}
        </div>

        <button 
          onClick={onClose}
          className="bg-red-600 hover:bg-red-700 text-white px-8 py-3 rounded-full font-bold tracking-wider transition-all transform hover:scale-105 shadow-lg"
        >
          TERMINATE LINK
        </button>
      </div>
    </div>
  );
};

export default VoiceInterface;