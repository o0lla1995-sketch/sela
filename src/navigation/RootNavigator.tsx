/**
 * Root navigation — react-navigation native-stack + bottom tabs.
 * ─────────────────────────────────────────────────────────────────
 * Replaces v1's hand-rolled zustand navigator which had no Android
 * hardware-back support, no transitions and no unified headers.
 * Structure (design.md §9):
 *
 *   RootStack
 *   ├── MainTabs   (الرئيسية · نقطة البيع · المخزون · التقارير · الإعدادات)
 *   ├── ProductForm
 *   ├── PrinterSettings
 *   ├── Diagnostics
 *   └── Notifications
 */
import React from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {I18nManager, View} from 'react-native';
import {Icon, type IconName} from '../components/Icon';
import {colors, fonts, typography} from '../core/theme';
import {HomeScreen} from '../screens/HomeScreen';
import {PosScreen} from '../screens/PosScreen';
import {InventoryScreen} from '../screens/inventory/InventoryScreen';
import {ReportsScreen} from '../screens/reports/ReportsScreen';
import {SettingsScreen} from '../screens/settings/SettingsScreen';
import {ProductFormScreen} from '../screens/inventory/ProductFormScreen';
import {PrinterSettingsScreen} from '../screens/printer/PrinterSettingsScreen';
import {DiagnosticsScreen} from '../screens/settings/DiagnosticsScreen';
import {NotificationsScreen} from '../screens/NotificationsScreen';

export type RootStackParamList = {
  MainTabs: undefined;
  ProductForm: {productId?: number} | undefined;
  PrinterSettings: undefined;
  Diagnostics: undefined;
  Notifications: undefined;
};

export type MainTabParamList = {
  Home: undefined;
  Pos: undefined;
  Inventory: undefined;
  Reports: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<MainTabParamList>();

const TAB_ITEMS: {
  name: keyof MainTabParamList;
  label: string;
  icon: IconName;
  component: React.ComponentType;
}[] = [
  {name: 'Home', label: 'الرئيسية', icon: 'home', component: HomeScreen},
  {name: 'Pos', label: 'نقطة البيع', icon: 'cart', component: PosScreen},
  {name: 'Inventory', label: 'المخزون', icon: 'box', component: InventoryScreen},
  {name: 'Reports', label: 'التقارير', icon: 'chart', component: ReportsScreen},
  {name: 'Settings', label: 'الإعدادات', icon: 'settings', component: SettingsScreen},
];

function MainTabs() {
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopWidth: 1,
          borderTopColor: colors.borderSoft,
          height: 62,
          paddingBottom: 8,
          paddingTop: 6,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textDim,
        tabBarLabelStyle: {
          fontFamily: fonts.bold,
          fontSize: typography.micro + 1,
        },
        tabBarIconStyle: {marginTop: 0},
      }}>
      {TAB_ITEMS.map(tab => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          component={tab.component}
          options={{
            title: tab.label,
            tabBarIcon: ({color, focused}) => (
              <View style={{alignItems: 'center', justifyContent: 'center'}}>
                <Icon name={tab.icon} size={22} color={color} />
                {focused ? <View style={styles.tabDot} /> : null}
              </View>
            ),
          }}
        />
      ))}
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          animation: I18N_RTL ? 'slide_from_left' : 'slide_from_right',
          contentStyle: {backgroundColor: colors.bg},
        }}>
        <Stack.Screen name="MainTabs" component={MainTabs} />
        <Stack.Screen
          name="ProductForm"
          component={ProductFormScreen}
          options={{animation: 'slide_from_bottom'}}
        />
        <Stack.Screen name="PrinterSettings" component={PrinterSettingsScreen} />
        <Stack.Screen name="Diagnostics" component={DiagnosticsScreen} />
        <Stack.Screen name="Notifications" component={NotificationsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// RTL: forward navigation slides from the left edge (the "next"
// direction in Arabic reading order).
const I18N_RTL = I18nManager.isRTL;

const styles = {
  tabDot: {
    position: 'absolute' as const,
    top: -6,
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.accent,
  },
};
