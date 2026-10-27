import { Tabs } from 'expo-router';
import { GlassTabBar } from '../../src/components/GlassTabBar';
import { ScreenBackground } from '../../src/components/ScreenBackground';

// The stack above paints each native screen with the theme background, so the tabs
// draw their own opaque background instead of relying on one behind the stack.
export default function TabsLayout() {
  return (
    <ScreenBackground>
      <Tabs
        initialRouteName="feed"
        tabBar={(props) => <GlassTabBar {...props} />}
        screenOptions={{ headerShown: false, sceneStyle: { backgroundColor: 'transparent' } }}
      >
        <Tabs.Screen name="feed" />
        <Tabs.Screen name="reading-list" />
        <Tabs.Screen name="lists" />
        <Tabs.Screen name="profile" />
      </Tabs>
    </ScreenBackground>
  );
}
