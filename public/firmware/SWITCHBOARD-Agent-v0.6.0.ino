/*
 * SWITCHBOARD Agent v0.6.0-browser-provisioning-candidate
 * Target: Arduino UNO R4 WiFi (Renesas RA4M1 user firmware)
 * Protocol: SWITCHBOARD Device Protocol 1
 *
 * This candidate uses the board-supported WiFiS3 stack and does not replace
 * ESP32-S3 bridge firmware. It starts every managed pin as INPUT, exchanges a
 * one-time enrollment token for a permanent credential, and never prints
 * Wi-Fi passwords, enrollment tokens, or device credentials.
 */

#include <Arduino.h>
#include <ArduinoHttpClient.h>
#include <ArduinoJson.h>
#include <EEPROM.h>
#include <WiFiS3.h>
#include <WebSocketsClient.h>

constexpr uint32_t CONFIG_MAGIC = 0x53574235; // SWB5
constexpr uint16_t CONFIG_LAYOUT_VERSION = 1;
constexpr uint16_t PROTOCOL_VERSION = 1;
constexpr uint32_t HEARTBEAT_INTERVAL_MS = 10000;
constexpr uint32_t COMMAND_POLL_INTERVAL_MS = 300;
constexpr uint32_t INPUT_SCAN_INTERVAL_MS = 100;
constexpr uint32_t SNAPSHOT_MAX_INTERVAL_MS = 5000;
constexpr uint32_t WIFI_RETRY_MIN_MS = 1000;
constexpr uint32_t RETRY_MAX_MS = 60000;
constexpr char AGENT_VERSION[] = "0.6.0-browser-provisioning-candidate";
constexpr char BOARD_PROFILE[] = "arduino-uno-r4-wifi";

struct AgentConfig {
  uint32_t magic;
  uint16_t layoutVersion;
  uint16_t serverPort;
  uint8_t secure;
  char ssid[33];
  char password[65];
  char serverHost[96];
  char socketPath[65];
  char enrollmentToken[97];
  char deviceName[49];
  char deviceId[81];
  char credential[97];
  uint32_t checksum;
};

enum class ManagedMode : uint8_t { INPUT_MODE, INPUT_PULLUP_MODE, OUTPUT_MODE, ANALOG_MODE, PWM_MODE };

struct ManagedPin {
  const char *id;
  uint8_t hardwarePin;
  ManagedMode mode;
  int value;
};

ManagedPin managedPins[] = {
  {"D0", D0, ManagedMode::INPUT_MODE, 0}, {"D1", D1, ManagedMode::INPUT_MODE, 0},
  {"D2", D2, ManagedMode::INPUT_MODE, 0}, {"D3", D3, ManagedMode::INPUT_MODE, 0},
  {"D4", D4, ManagedMode::INPUT_MODE, 0}, {"D5", D5, ManagedMode::INPUT_MODE, 0},
  {"D6", D6, ManagedMode::INPUT_MODE, 0}, {"D7", D7, ManagedMode::INPUT_MODE, 0},
  {"D8", D8, ManagedMode::INPUT_MODE, 0}, {"D9", D9, ManagedMode::INPUT_MODE, 0},
  {"D10", D10, ManagedMode::INPUT_MODE, 0}, {"D11", D11, ManagedMode::INPUT_MODE, 0},
  {"D12", D12, ManagedMode::INPUT_MODE, 0}, {"D13", D13, ManagedMode::INPUT_MODE, 0},
  {"A0", A0, ManagedMode::INPUT_MODE, 0}, {"A1", A1, ManagedMode::INPUT_MODE, 0},
  {"A2", A2, ManagedMode::INPUT_MODE, 0}, {"A3", A3, ManagedMode::INPUT_MODE, 0},
  {"A4", A4, ManagedMode::INPUT_MODE, 0}, {"A5", A5, ManagedMode::INPUT_MODE, 0},
};
constexpr size_t MANAGED_PIN_COUNT = sizeof(managedPins) / sizeof(managedPins[0]);

struct PendingLog {
  char level[6];
  char code[40];
  char message[121];
  uint32_t uptimeMs;
};

AgentConfig config{};
PendingLog pendingLogs[8]{};
WebSocketsClient webSocket;
WiFiClient plainHttpClient;
WiFiSSLClient secureHttpClient;
String serialBuffer;
uint8_t pendingLogCount = 0;
bool socketConfigured = false;
bool socketAuthenticated = false;
bool snapshotDirty = true;
uint32_t heartbeatSequence = 0;
uint32_t snapshotSequence = 0;
uint32_t lastHeartbeatAt = 0;
uint32_t lastCommandPollAt = 0;
uint32_t lastInputScanAt = 0;
uint32_t lastSnapshotAt = 0;
uint32_t nextWifiAttemptAt = 0;
uint32_t nextEnrollmentAttemptAt = 0;
uint32_t wifiBackoffMs = WIFI_RETRY_MIN_MS;
uint32_t enrollmentBackoffMs = WIFI_RETRY_MIN_MS;
uint32_t socketBackoffMs = WIFI_RETRY_MIN_MS;
int previousWifiStatus = WL_IDLE_STATUS;

uint32_t boundedDouble(uint32_t value) {
  return value >= RETRY_MAX_MS / 2 ? RETRY_MAX_MS : value * 2;
}

bool timeReached(uint32_t now, uint32_t target) {
  return static_cast<int32_t>(now - target) >= 0;
}

uint32_t checksumConfig(const AgentConfig &candidate) {
  const uint8_t *bytes = reinterpret_cast<const uint8_t *>(&candidate);
  uint32_t hash = 2166136261u;
  for (size_t index = 0; index < offsetof(AgentConfig, checksum); ++index) {
    hash ^= bytes[index];
    hash *= 16777619u;
  }
  return hash;
}

bool hasCredential() {
  return config.deviceId[0] != '\0' && strncmp(config.credential, "swdev_", 6) == 0;
}

bool loadConfig() {
  EEPROM.get(0, config);
  return config.magic == CONFIG_MAGIC && config.layoutVersion == CONFIG_LAYOUT_VERSION &&
    config.checksum == checksumConfig(config) && config.ssid[0] != '\0' && config.serverHost[0] != '\0';
}

void saveConfig() {
  config.magic = CONFIG_MAGIC;
  config.layoutVersion = CONFIG_LAYOUT_VERSION;
  config.checksum = checksumConfig(config);
  EEPROM.put(0, config);
}

void clearConfig() {
  AgentConfig blank{};
  EEPROM.put(0, blank);
  config = blank;
}

const char *modeName(ManagedMode mode) {
  switch (mode) {
    case ManagedMode::INPUT_MODE: return "INPUT";
    case ManagedMode::INPUT_PULLUP_MODE: return "INPUT_PULLUP";
    case ManagedMode::OUTPUT_MODE: return "OUTPUT";
    case ManagedMode::ANALOG_MODE: return "ANALOG";
    case ManagedMode::PWM_MODE: return "PWM";
  }
  return "INPUT";
}

ManagedPin *findPin(const char *pinId) {
  if (!pinId) return nullptr;
  for (size_t index = 0; index < MANAGED_PIN_COUNT; ++index) {
    if (strcmp(managedPins[index].id, pinId) == 0) return &managedPins[index];
  }
  return nullptr;
}

int samplePin(ManagedPin &pin) {
  if (pin.mode == ManagedMode::ANALOG_MODE) return analogRead(pin.hardwarePin);
  if (pin.mode == ManagedMode::PWM_MODE) return pin.value;
  return digitalRead(pin.hardwarePin) == HIGH ? 1 : 0;
}

void startPinsSafe() {
  for (size_t index = 0; index < MANAGED_PIN_COUNT; ++index) {
    pinMode(managedPins[index].hardwarePin, INPUT);
    managedPins[index].mode = ManagedMode::INPUT_MODE;
    managedPins[index].value = digitalRead(managedPins[index].hardwarePin) == HIGH ? 1 : 0;
  }
  snapshotDirty = true;
}

void sendAgentLog(const char *level, const char *code, const char *message, uint32_t uptimeMs) {
  if (!socketAuthenticated) return;
  StaticJsonDocument<384> payload;
  payload["type"] = "device.log";
  payload["level"] = level;
  payload["code"] = code;
  payload["message"] = message;
  payload["deviceUptimeMs"] = uptimeMs;
  String serialized;
  serializeJson(payload, serialized);
  webSocket.sendTXT(serialized);
}

void queueAgentLog(const char *level, const char *code, const char *message, uint32_t uptimeMs) {
  if (pendingLogCount == 8) {
    for (uint8_t index = 1; index < 8; ++index) pendingLogs[index - 1] = pendingLogs[index];
    pendingLogCount = 7;
  }
  PendingLog &entry = pendingLogs[pendingLogCount++];
  strlcpy(entry.level, level, sizeof(entry.level));
  strlcpy(entry.code, code, sizeof(entry.code));
  strlcpy(entry.message, message, sizeof(entry.message));
  entry.uptimeMs = uptimeMs;
}

void logEvent(const char *level, const char *code, const char *message = "") {
  StaticJsonDocument<320> output;
  output["type"] = "agent.log";
  output["level"] = level;
  output["code"] = code;
  output["message"] = message;
  output["uptimeMs"] = millis();
  serializeJson(output, Serial);
  Serial.println();
  if (socketAuthenticated) sendAgentLog(level, code, message, millis());
  else queueAgentLog(level, code, message, millis());
}

void flushPendingLogs() {
  for (uint8_t index = 0; index < pendingLogCount; ++index) {
    sendAgentLog(pendingLogs[index].level, pendingLogs[index].code, pendingLogs[index].message, pendingLogs[index].uptimeMs);
  }
  pendingLogCount = 0;
}

String hardwareIdentifier() {
  byte mac[6]{};
  WiFi.macAddress(mac);
  char output[40];
  snprintf(output, sizeof(output), "uno-r4-wifi-%02X%02X%02X%02X%02X%02X",
    mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  return String(output);
}

template <typename NetworkClient>
bool exchangeEnrollmentWith(NetworkClient &networkClient) {
  StaticJsonDocument<512> request;
  request["token"] = config.enrollmentToken;
  request["hardwareId"] = hardwareIdentifier();
  String requestBody;
  serializeJson(request, requestBody);

  HttpClient http(networkClient, config.serverHost, config.serverPort);
  http.setHttpResponseTimeout(10000);
  const int requestResult = http.post("/api/device-enrollment/exchange", "application/json", requestBody);
  if (requestResult != 0) {
    http.stop();
    logEvent("WARN", "ENROLLMENT_TRANSPORT_FAILED", "Server connection failed");
    return false;
  }
  const int status = http.responseStatusCode();
  const String responseBody = http.responseBody();
  http.stop();
  if (status != 201) {
    logEvent("ERROR", "ENROLLMENT_REJECTED", "One-time token exchange was rejected");
    return false;
  }

  DynamicJsonDocument response(2048);
  if (deserializeJson(response, responseBody)) {
    logEvent("ERROR", "ENROLLMENT_RESPONSE_INVALID", "Server response was not valid JSON");
    return false;
  }
  const char *deviceId = response["device"]["id"] | "";
  const char *credential = response["credential"] | "";
  const char *socketPath = response["socketPath"] | "/api/device/socket";
  const int protocolVersion = response["protocolVersion"] | 0;
  if (!deviceId[0] || strncmp(credential, "swdev_", 6) != 0 || protocolVersion != PROTOCOL_VERSION) {
    logEvent("ERROR", "ENROLLMENT_RESPONSE_INCOMPLETE", "Credential response failed validation");
    return false;
  }
  strlcpy(config.deviceId, deviceId, sizeof(config.deviceId));
  strlcpy(config.credential, credential, sizeof(config.credential));
  strlcpy(config.socketPath, socketPath, sizeof(config.socketPath));
  memset(config.enrollmentToken, 0, sizeof(config.enrollmentToken));
  saveConfig();
  logEvent("INFO", "ENROLLMENT_COMPLETE", "Permanent credential stored; token erased");
  return true;
}

bool exchangeEnrollment() {
  if (hasCredential()) return true;
  if (!config.enrollmentToken[0]) {
    logEvent("ERROR", "ENROLLMENT_TOKEN_MISSING", "Reprovision with a new one-time token");
    return false;
  }
  return config.secure ? exchangeEnrollmentWith(secureHttpClient) : exchangeEnrollmentWith(plainHttpClient);
}

void sendAuthentication() {
  StaticJsonDocument<384> message;
  message["type"] = "device.authenticate";
  message["protocolVersion"] = PROTOCOL_VERSION;
  message["deviceId"] = config.deviceId;
  message["credential"] = config.credential;
  String payload;
  serializeJson(message, payload);
  webSocket.sendTXT(payload);
}

void sendHeartbeat() {
  StaticJsonDocument<384> message;
  message["type"] = "device.heartbeat";
  message["sequence"] = ++heartbeatSequence;
  message["uptimeMs"] = millis();
  message["rssiDbm"] = WiFi.RSSI();
  message["ipAddress"] = WiFi.localIP().toString();
  message["agentVersion"] = AGENT_VERSION;
  message["firmwareVersion"] = WiFi.firmwareVersion();
  String payload;
  serializeJson(message, payload);
  webSocket.sendTXT(payload);
}

void sendSnapshot() {
  DynamicJsonDocument message(3072);
  message["type"] = "device.snapshot";
  message["sequence"] = ++snapshotSequence;
  JsonArray pins = message.createNestedArray("pins");
  for (size_t index = 0; index < MANAGED_PIN_COUNT; ++index) {
    ManagedPin &pin = managedPins[index];
    pin.value = samplePin(pin);
    JsonObject item = pins.createNestedObject();
    item["pinId"] = pin.id;
    item["mode"] = modeName(pin.mode);
    item["value"] = pin.value;
  }
  String payload;
  serializeJson(message, payload);
  webSocket.sendTXT(payload);
  snapshotDirty = false;
  lastSnapshotAt = millis();
}

void pollForCommand() {
  webSocket.sendTXT("{\"type\":\"device.command.poll\"}");
}

void sendAcknowledgment(const char *commandId, ManagedPin *pin, const char *error = nullptr) {
  StaticJsonDocument<384> message;
  message["type"] = "gpio.ack";
  message["commandId"] = commandId;
  message["pinId"] = pin ? pin->id : "UNKNOWN";
  message["confirmedMode"] = pin ? modeName(pin->mode) : "INPUT";
  message["confirmedValue"] = pin ? samplePin(*pin) : 0;
  message["deviceTimestampMs"] = millis();
  if (error) message["error"] = error;
  String payload;
  serializeJson(message, payload);
  webSocket.sendTXT(payload);
}

void applyGpioCommand(JsonDocument &message) {
  const char *commandId = message["commandId"] | "";
  const char *kind = message["kind"] | "";
  const char *pinId = message["pinId"] | "";
  ManagedPin *pin = findPin(pinId);
  if (!commandId[0] || !pin) {
    sendAcknowledgment(commandId[0] ? commandId : "INVALID", pin, "UNKNOWN_PIN");
    logEvent("WARN", "GPIO_COMMAND_REJECTED", "Unknown or malformed pin command");
    return;
  }

  if (strcmp(kind, "SET_MODE") == 0) {
    const char *requestedMode = message["requestedMode"] | "";
    if (strcmp(requestedMode, "INPUT") == 0) {
      pinMode(pin->hardwarePin, INPUT);
      pin->mode = ManagedMode::INPUT_MODE;
    } else if (strcmp(requestedMode, "INPUT_PULLUP") == 0) {
      pinMode(pin->hardwarePin, INPUT_PULLUP);
      pin->mode = ManagedMode::INPUT_PULLUP_MODE;
    } else if (strcmp(requestedMode, "OUTPUT") == 0) {
      digitalWrite(pin->hardwarePin, LOW);
      pinMode(pin->hardwarePin, OUTPUT);
      pin->mode = ManagedMode::OUTPUT_MODE;
    } else {
      sendAcknowledgment(commandId, pin, "UNSUPPORTED_MODE");
      logEvent("WARN", "GPIO_MODE_REJECTED", "Only Batch 4 digital modes are accepted");
      return;
    }
    pin->value = samplePin(*pin);
    snapshotDirty = true;
    sendAcknowledgment(commandId, pin);
    logEvent("INFO", "GPIO_MODE_APPLIED", pin->id);
    return;
  }

  if (strcmp(kind, "WRITE") == 0) {
    if (pin->mode != ManagedMode::OUTPUT_MODE) {
      sendAcknowledgment(commandId, pin, "PIN_NOT_OUTPUT");
      logEvent("WARN", "GPIO_WRITE_REJECTED", "Pin is not configured as output");
      return;
    }
    const int requestedValue = message["requestedValue"] | -1;
    if (requestedValue != 0 && requestedValue != 1) {
      sendAcknowledgment(commandId, pin, "INVALID_DIGITAL_VALUE");
      return;
    }
    digitalWrite(pin->hardwarePin, requestedValue ? HIGH : LOW);
    pin->value = digitalRead(pin->hardwarePin) == HIGH ? 1 : 0;
    snapshotDirty = true;
    sendAcknowledgment(commandId, pin);
    logEvent("INFO", "GPIO_WRITE_APPLIED", pin->id);
    return;
  }

  sendAcknowledgment(commandId, pin, "UNSUPPORTED_COMMAND");
}

void handleServerMessage(uint8_t *payload, size_t length) {
  DynamicJsonDocument message(2048);
  if (deserializeJson(message, payload, length)) {
    logEvent("WARN", "SERVER_MESSAGE_INVALID", "Invalid JSON received");
    return;
  }
  const char *type = message["type"] | "";
  if (strcmp(type, "device.authenticated") == 0) {
    socketAuthenticated = true;
    socketBackoffMs = WIFI_RETRY_MIN_MS;
    webSocket.setReconnectInterval(socketBackoffMs);
    flushPendingLogs();
    logEvent("INFO", "SOCKET_AUTHENTICATED", "Authenticated device session opened");
    sendHeartbeat();
    sendSnapshot();
    pollForCommand();
    return;
  }
  if (strcmp(type, "gpio.command") == 0) {
    applyGpioCommand(message);
    return;
  }
  if (strcmp(type, "device.error") == 0) {
    logEvent("WARN", "SERVER_REJECTED_MESSAGE", message["code"] | "Unknown server error");
  }
}

void onWebSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      socketAuthenticated = false;
      logEvent("INFO", "SOCKET_CONNECTED", "WebSocket transport connected");
      sendAuthentication();
      break;
    case WStype_DISCONNECTED:
      socketAuthenticated = false;
      socketBackoffMs = boundedDouble(socketBackoffMs);
      webSocket.setReconnectInterval(socketBackoffMs);
      logEvent("WARN", "SOCKET_DISCONNECTED", "Retrying with bounded backoff");
      break;
    case WStype_TEXT:
      handleServerMessage(payload, length);
      break;
    default:
      break;
  }
}

void configureWebSocket() {
  if (socketConfigured || !hasCredential()) return;
  webSocket.onEvent(onWebSocketEvent);
  webSocket.setReconnectInterval(socketBackoffMs);
  webSocket.enableHeartbeat(15000, 3000, 2);
  const char *path = config.socketPath[0] ? config.socketPath : "/api/device/socket";
  if (config.secure) webSocket.beginSSL(config.serverHost, config.serverPort, path);
  else webSocket.begin(config.serverHost, config.serverPort, path);
  socketConfigured = true;
}

void maintainWifi() {
  const int status = WiFi.status();
  const uint32_t now = millis();
  if (status == WL_CONNECTED) {
    if (previousWifiStatus != WL_CONNECTED) {
      wifiBackoffMs = WIFI_RETRY_MIN_MS;
      logEvent("INFO", "WIFI_CONNECTED", "Network connection established");
    }
    previousWifiStatus = status;
    return;
  }
  if (previousWifiStatus == WL_CONNECTED) {
    socketAuthenticated = false;
    webSocket.disconnect();
    socketConfigured = false;
    logEvent("WARN", "WIFI_DISCONNECTED", "Network connection lost");
  }
  previousWifiStatus = status;
  if (!timeReached(now, nextWifiAttemptAt)) return;
  logEvent("INFO", "WIFI_CONNECTING", "Attempting configured network");
  WiFi.begin(config.ssid, config.password);
  nextWifiAttemptAt = now + wifiBackoffMs;
  wifiBackoffMs = boundedDouble(wifiBackoffMs);
}

void scanInputs() {
  for (size_t index = 0; index < MANAGED_PIN_COUNT; ++index) {
    ManagedPin &pin = managedPins[index];
    if (pin.mode != ManagedMode::INPUT_MODE && pin.mode != ManagedMode::INPUT_PULLUP_MODE && pin.mode != ManagedMode::ANALOG_MODE) continue;
    const int sampled = samplePin(pin);
    if (sampled != pin.value) {
      pin.value = sampled;
      snapshotDirty = true;
    }
  }
}

bool copyProvisionField(char *destination, size_t destinationSize, JsonVariantConst source, const char *fallback = "") {
  const char *value = source.is<const char *>() ? source.as<const char *>() : fallback;
  if (!value || strlen(value) >= destinationSize) return false;
  strlcpy(destination, value, destinationSize);
  return true;
}

void processProvisioningLine(const String &line) {
  DynamicJsonDocument request(2048);
  if (deserializeJson(request, line)) {
    logEvent("ERROR", "PROVISION_INVALID_JSON", "Provisioning line was not valid JSON");
    return;
  }
  const char *action = request["action"] | "";
  if (strcmp(action, "status") == 0 || strcmp(action, "identify") == 0) {
    StaticJsonDocument<384> status;
    status["type"] = strcmp(action, "identify") == 0 ? "agent.identity" : "agent.status";
    status["agentVersion"] = AGENT_VERSION;
    status["boardProfile"] = BOARD_PROFILE;
    status["configured"] = config.magic == CONFIG_MAGIC;
    status["enrolled"] = hasCredential();
    status["wifiConnected"] = WiFi.status() == WL_CONNECTED;
    status["socketAuthenticated"] = socketAuthenticated;
    status["deviceId"] = hasCredential() ? config.deviceId : "";
    serializeJson(status, Serial);
    Serial.println();
    return;
  }
  if (strcmp(action, "clear") == 0) {
    clearConfig();
    logEvent("INFO", "CONFIG_CLEARED", "Stored network and device credential erased");
    StaticJsonDocument<160> cleared;
    cleared["type"] = "agent.cleared";
    cleared["agentVersion"] = AGENT_VERSION;
    cleared["boardProfile"] = BOARD_PROFILE;
    cleared["configured"] = false;
    cleared["enrolled"] = false;
    serializeJson(cleared, Serial);
    Serial.println();
    Serial.flush();
    delay(75);
    NVIC_SystemReset();
    return;
  }
  if (strcmp(action, "provision") != 0) {
    logEvent("WARN", "PROVISION_ACTION_UNKNOWN", "Use identify, provision, status, or clear");
    return;
  }

  AgentConfig candidate{};
  candidate.magic = CONFIG_MAGIC;
  candidate.layoutVersion = CONFIG_LAYOUT_VERSION;
  const int requestedPort = request["serverPort"] | 443;
  candidate.serverPort = requestedPort >= 1 && requestedPort <= 65535 ? requestedPort : 443;
  candidate.secure = request["secure"] | true;
  const bool valid = copyProvisionField(candidate.ssid, sizeof(candidate.ssid), request["wifiSsid"]) && candidate.ssid[0] &&
    copyProvisionField(candidate.password, sizeof(candidate.password), request["wifiPassword"]) &&
    copyProvisionField(candidate.serverHost, sizeof(candidate.serverHost), request["serverHost"]) && candidate.serverHost[0] &&
    copyProvisionField(candidate.enrollmentToken, sizeof(candidate.enrollmentToken), request["enrollmentToken"]) &&
    strncmp(candidate.enrollmentToken, "swenr_", 6) == 0 &&
    copyProvisionField(candidate.deviceName, sizeof(candidate.deviceName), request["deviceName"], "SWITCHBOARD Device");
  if (!valid || strchr(candidate.serverHost, '/') || strchr(candidate.serverHost, ':')) {
    logEvent("ERROR", "PROVISION_FIELDS_INVALID", "Check field lengths and use a hostname without scheme or path");
    return;
  }
  strlcpy(candidate.socketPath, "/api/device/socket", sizeof(candidate.socketPath));
  candidate.checksum = checksumConfig(candidate);
  config = candidate;
  EEPROM.put(0, config);
  logEvent("INFO", "PROVISION_STORED", "Configuration stored; secrets omitted from logs");
  StaticJsonDocument<192> stored;
  stored["type"] = "agent.provisioned";
  stored["agentVersion"] = AGENT_VERSION;
  stored["boardProfile"] = BOARD_PROFILE;
  stored["configured"] = true;
  stored["enrolled"] = false;
  serializeJson(stored, Serial);
  Serial.println();
  Serial.flush();
  delay(75);
  NVIC_SystemReset();
}

void pollSerialProvisioning() {
  while (Serial.available()) {
    const char character = static_cast<char>(Serial.read());
    if (character == '\n') {
      if (serialBuffer.length()) processProvisioningLine(serialBuffer);
      serialBuffer = "";
    } else if (character != '\r') {
      if (serialBuffer.length() < 2048) serialBuffer += character;
      else {
        serialBuffer = "";
        logEvent("ERROR", "SERIAL_LINE_TOO_LONG", "Provisioning line exceeded 2048 bytes");
      }
    }
  }
}

void setup() {
  Serial.begin(115200);
  const uint32_t waitStarted = millis();
  while (!Serial && millis() - waitStarted < 1500) delay(10);
  analogReadResolution(14);
  startPinsSafe();
  logEvent("INFO", "AGENT_BOOT", AGENT_VERSION);
  logEvent("INFO", "GPIO_SAFE_BOOT", "All managed pins initialized as inputs");
  if (!loadConfig()) {
    memset(&config, 0, sizeof(config));
    logEvent("WARN", "PROVISION_REQUIRED", "Send a provisioning JSON line over USB serial");
    return;
  }
  logEvent("INFO", "CONFIG_LOADED", "Stored configuration checksum verified");
}

void loop() {
  pollSerialProvisioning();
  if (config.magic != CONFIG_MAGIC) return;
  maintainWifi();
  if (WiFi.status() != WL_CONNECTED) return;

  const uint32_t now = millis();
  if (!hasCredential()) {
    if (timeReached(now, nextEnrollmentAttemptAt)) {
      if (exchangeEnrollment()) enrollmentBackoffMs = WIFI_RETRY_MIN_MS;
      else {
        nextEnrollmentAttemptAt = now + enrollmentBackoffMs;
        enrollmentBackoffMs = boundedDouble(enrollmentBackoffMs);
      }
    }
    return;
  }

  configureWebSocket();
  webSocket.loop();
  if (!socketAuthenticated) return;

  if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
    lastHeartbeatAt = now;
    sendHeartbeat();
  }
  if (now - lastCommandPollAt >= COMMAND_POLL_INTERVAL_MS) {
    lastCommandPollAt = now;
    pollForCommand();
  }
  if (now - lastInputScanAt >= INPUT_SCAN_INTERVAL_MS) {
    lastInputScanAt = now;
    scanInputs();
  }
  if (snapshotDirty || now - lastSnapshotAt >= SNAPSHOT_MAX_INTERVAL_MS) sendSnapshot();
}
