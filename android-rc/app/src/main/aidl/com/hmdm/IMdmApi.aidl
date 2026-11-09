package com.hmdm;

import com.hmdm.IMdmApiCallback;

interface IMdmApi {
    Bundle queryConfig();
    void log(long timestamp, int level, String packageId, String message);
    String queryAppPreference(String packageId, String attr);
    boolean setAppPreference(String packageId, String attr, String value);
    void commitAppPreferences(String packageId);
    int getVersion();
    Bundle queryPrivilegedConfig(String apiKey);
    void setCustom(int number, String value);
    void forceConfigUpdate();
    boolean sendPush(String apiKey, String type, String payload);
    void forceConfigUpdateWithCallback(IMdmApiCallback callback);
}
