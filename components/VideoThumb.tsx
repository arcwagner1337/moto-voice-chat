import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Video, ResizeMode } from 'expo-av';
import { Ionicons } from '@expo/vector-icons';

// Обложка видео-вложения: показываем первый кадр (Video на паузе) с кнопкой
// play поверх. По тапу открывается полноэкранный встроенный плеер.
export default function VideoThumb({
  url,
  onPress,
  className,
}: {
  url: string;
  onPress: () => void;
  className?: string;
}) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.85} className={className}>
      <Video
        source={{ uri: url }}
        style={StyleSheet.absoluteFill}
        resizeMode={ResizeMode.COVER}
        shouldPlay={false}
        isMuted
      />
      <View className="absolute inset-0 items-center justify-center bg-black/20">
        <View className="w-11 h-11 rounded-full bg-black/55 items-center justify-center">
          <Ionicons name="play" size={22} color="#fff" style={{ marginLeft: 2 }} />
        </View>
      </View>
    </TouchableOpacity>
  );
}
