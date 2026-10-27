import { StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';

/**
 * A white-to-transparent linear gradient laid over a glass surface, at a CSS-style
 * angle (180 is top to bottom). `stops` are [offset, opacity] pairs.
 */
export function Sheen({
  id,
  width,
  height,
  angle,
  color,
  stops,
}: {
  id: string;
  width: number;
  height: number;
  angle: number;
  color: string;
  stops: ReadonlyArray<readonly [number, number]>;
}) {
  const theta = (angle * Math.PI) / 180;
  const dx = Math.sin(theta);
  const dy = -Math.cos(theta);
  const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
  return (
    <Svg style={StyleSheet.absoluteFill} width={width} height={height} pointerEvents="none">
      <Defs>
        <LinearGradient
          id={id}
          gradientUnits="userSpaceOnUse"
          x1={width / 2 - dx * half}
          y1={height / 2 - dy * half}
          x2={width / 2 + dx * half}
          y2={height / 2 + dy * half}
        >
          {stops.map(([offset, opacity]) => (
            <Stop key={offset} offset={offset} stopColor={color} stopOpacity={opacity} />
          ))}
        </LinearGradient>
      </Defs>
      <Rect width={width} height={height} fill={`url(#${id})`} />
    </Svg>
  );
}
