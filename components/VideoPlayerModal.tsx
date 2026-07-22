import React from 'react';
import { Modal, View, TouchableOpacity, Text } from 'react-native';
import { Video, ResizeMode } from 'expo-av';

// Встроенный полноэкранный видеоплеер (expo-av, нативные контролы):
// play/pause, перемотка, громкость — всё внутри приложения, без перехода
// по ссылке. Используется для видео из чата и меток на карте.
export default function VideoPlayerModal({
  url,
  onClose,
}: {
  url: string | null;
  onClose: () => void;
}) {
  return (
    <Modal visible={!!url} transparent animationType="fade" onRequestClose={onClose}>
      <View className="flex-1 bg-black items-center justify-center">
        {url && (
          <Video
            source={{ uri: url }}
            style={{ width: '100%', height: '100%' }}
            resizeMode={ResizeMode.CONTAIN}
            useNativeControls
            shouldPlay
          />
        )}
        <TouchableOpacity
          onPress={onClose}
          style={{ position: 'absolute', top: 48, right: 16 }}
          className="w-10 h-10 rounded-full bg-black/60 border border-white/20 items-center justify-center"
        >
          <Text className="text-white text-lg">✕</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}
