/**
 * Root navigation — react-navigation native-stack + bottom tabs.
 * ─────────────────────────────────────────────────────────────────
 * v3: theme-aware chrome (light/dark) + new management screens:
 *
 *   RootStack
 *   ├── MainTabs   (الرئيسية · نقطة البيع · المخزون · التقارير · الإعدادات)
 *   ├── ProductForm
 *   ├── Stocktake          (الجرد + التقرير الكامل)
 *   ├── ManageCategories   (تصنيفات المستخدم)
 *   ├── ManageUnits        (وحدات المستخدم)
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
import {fonts, makeStyles, typography, useThemeColors} from '../core/theme';
import {HomeScreen} from '../screens/HomeScreen';
import {PosScreen} from '../screens/PosScreen';
import {InventoryScreen} from '../screens/inventory/InventoryScreen';
import {ReportsScreen} from '../screens/reports/ReportsScreen';
import {SettingsScreen} from '../screens/settings/SettingsScreen';
import {ProductFormScreen} from '../screens/inventory/ProductFormScreen';
import {StocktakeScreen} from '../screens/inventory/StocktakeScreen';
import {ManageCategoriesScreen} from '../screens/inventory/ManageCategoriesScreen';
import {ManageUnitsScreen} from '../screens/inventory/ManageUnitsScreen';
import {PrinterSettingsScreen} from '../screens/printer/PrinterSettingsScreen';
import {DiagnosticsScreen} from '../screens/settings/DiagnosticsScreen';
import {NotificationsScreen} from '../screens/NotificationsScreen';

export type RootStackParamList = {
  MainTabs: undefined;
  ProductForm: {productId?: number; barcode?: string} | undefined;
  Stocktake: undefined;
  ManageCategories: undefined;
  ManageUnits: undefined;
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
  {
    name: 'Inventory',
    label: 'المخزون',
    icon: 'box',
    component: InventoryScreen,
  },
  {name: 'Reports', label: 'التقارير', icon: 'chart', component: ReportsScreen},
  {
    name: 'Settings',
    label: 'الإعدادات',
    icon: 'settings',
    component: SettingsScreen,
  },
];

function MainTabs() {
  const c = useThemeColors();
  return (
    <Tabs.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: c.surface,
          borderTopWidth: 1,
          borderTopColor: c.borderSoft,
          height: 62,
          paddingBottom: 8,
          paddingTop: 6,
        },
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.textDim,
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
                {focused ? (
                  <View style={{...tabDot, backgroundColor: c.accent}} />
                ) : null}
              </View>
            ),
          }}
        />
      ))}
    </Tabs.Navigator>
  );
}

const tabDot = {
  position: 'absolute' as const,
  top: -6,
  width: 4,
  height: 4,
  borderRadius: 2,
};

export function RootNavigator() {
  const c = useThemeColors();
  return (
    <NavigationContainer>
      <Stack.Navigator
        screenOptions={{
          headerShown: false,
          animation: I18nManager.isRTL ? 'slide_from_left' : 'slide_from_right',
          contentStyle: {backgroundColor: c.bg},
        }}>
        <Stack.Screen name="MainTabs" component={MainTabs} />
        <Stack.Screen
          name="ProductForm"
          component={ProductFormScreen}
          options={{animation: 'slide_from_bottom'}}
        />
        <Stack.Screen name="Stocktake" component={StocktakeScreen} />
        <Stack.Screen
          name="ManageCategories"
          component={ManageCategoriesScreen}
        />
        <Stack.Screen
          name="ManageUnits"
          component={ManageUnitsScreen}
          options={{animation: 'slide_from_bottom'}}
        />
        <Stack.Screen
          name="PrinterSettings"
          component={PrinterSettingsScreen}
        />
        <Stack.Screen name="Diagnostics" component={DiagnosticsScreen} />
        <Stack.Screen name="Notifications" component={NotificationsScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

// Keep makeStyles imported for future per-screen styles (tree-shaken).
export const useNavStyles = makeStyles(() => ({noop: {}} as const));
