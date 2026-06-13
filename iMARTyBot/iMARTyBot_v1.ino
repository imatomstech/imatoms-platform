// ═══════════════════════════════════════════════════════════
// iMARTyBot v1.0 — TKO iMATOMs Tech
// ESP32 DevKitV1
// Sensors: RFID RC522, DHT11, Servo, Buzzer, LCD 16x2 (I2C)
// ═══════════════════════════════════════════════════════════

#include <WiFi.h>
#include <WebServer.h>
#include <SPI.h>
#include <MFRC522.h>
#include <DHT.h>
#include <ESP32Servo.h>
#include <LiquidCrystal_I2C.h>
#include <ArduinoJson.h>

// ── WiFi ──────────────────────────────────────────────────
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";

// ── iMATOMs Backend API ───────────────────────────────────
const char* API_HOST  = "bas.imatomstech.com";
const int   API_PORT  = 80;

// ── RFID RC522 ────────────────────────────────────────────
#define SS_PIN   5    // SDA
#define RST_PIN  22
MFRC522 rfid(SS_PIN, RST_PIN);

// UID บัตรที่อนุญาต (อ่านจาก Serial แล้วใส่ที่นี่)
String AUTHORIZED_UID = "A1B2C3D4";

// ── DHT11 ─────────────────────────────────────────────────
#define DHT_PIN  4
#define DHT_TYPE DHT11
DHT dht(DHT_PIN, DHT_TYPE);

// ── Servo Motor (พัดลม) ───────────────────────────────────
#define SERVO_PIN 13
Servo fanServo;
int servoSpeed = 0;   // 0=หยุด, 1=ช้า(60°), 2=กลาง(120°), 3=เร็ว(180°)

// ── Buzzer ────────────────────────────────────────────────
#define BUZZER_PIN 2

// ── LCD I2C 16x2 ──────────────────────────────────────────
LiquidCrystal_I2C lcd(0x27, 16, 2);

// ── IR Remote ─────────────────────────────────────────────
// ใช้ GPIO interrupt อ่าน NEC protocol
#define IR_PIN 15

// ── State ─────────────────────────────────────────────────
bool systemActive = false;
unsigned long lastDHTRead = 0;
unsigned long lastAPIPost = 0;
float lastTemp = 0, lastHumi = 0;

// ── WebServer สำหรับ iMATOMs Platform ────────────────────
WebServer server(80);

// ═══════════════════════════════════════════════════════════
// SETUP
// ═══════════════════════════════════════════════════════════
void setup() {
  Serial.begin(115200);

  // WiFi
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Connecting WiFi");
  int retry = 0;
  while (WiFi.status() != WL_CONNECTED && retry < 20) {
    delay(500); Serial.print("."); retry++;
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("WiFi OK: " + WiFi.localIP().toString());
  }

  // SPI + RFID
  SPI.begin();
  rfid.PCD_Init();

  // DHT
  dht.begin();

  // Servo
  fanServo.attach(SERVO_PIN);
  fanServo.write(90); // หยุด (continuous servo: 90=stop)

  // Buzzer
  pinMode(BUZZER_PIN, OUTPUT);

  // LCD
  lcd.init();
  lcd.backlight();
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("  iMARTyBot v1  ");
  lcd.setCursor(0, 1);
  lcd.print(" TKO iMATOMs    ");

  // Web Server endpoints
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/sensor", HTTP_GET, handleSensor);
  server.on("/control", HTTP_POST, handleControl);
  server.on("/", HTTP_GET, [](){
    server.send(200, "application/json",
      "{\"device\":\"iMARTyBot\",\"version\":\"1.0\",\"status\":\"online\"}");
  });
  server.enableCORS(true);
  server.begin();
  Serial.println("Web server started");

  beep(1); // บีพเริ่มต้น
  Serial.println("iMARTyBot Ready — Scan RFID card");
}

// ═══════════════════════════════════════════════════════════
// LOOP
// ═══════════════════════════════════════════════════════════
void loop() {
  server.handleClient();

  // ── อ่าน RFID ──
  if (rfid.PICC_IsNewCardPresent() && rfid.PICC_ReadCardSerial()) {
    String uid = getUID();
    Serial.println("Card UID: " + uid);

    if (uid == AUTHORIZED_UID) {
      if (!systemActive) {
        activateSystem();
      } else {
        deactivateSystem();
      }
    } else {
      Serial.println("Unauthorized card: " + uid);
      beepError();
    }
    rfid.PICC_HaltA();
    rfid.PCD_StopCrypto1();
    delay(1000); // debounce
  }

  // ── อ่าน DHT11 ทุก 5 วินาที ──
  if (systemActive && millis() - lastDHTRead > 5000) {
    lastDHTRead = millis();
    float t = dht.readTemperature();
    float h = dht.readHumidity();
    if (!isnan(t) && !isnan(h)) {
      lastTemp = t; lastHumi = h;
      updateLCD(t, h);
    }
  }

  // ── ส่งข้อมูลขึ้น iMATOMs API ทุก 30 วินาที ──
  if (systemActive && millis() - lastAPIPost > 30000) {
    lastAPIPost = millis();
    postSensorData(lastTemp, lastHumi);
  }
}

// ═══════════════════════════════════════════════════════════
// RFID FUNCTIONS
// ═══════════════════════════════════════════════════════════
String getUID() {
  String uid = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) uid += "0";
    uid += String(rfid.uid.uidByte[i], HEX);
  }
  uid.toUpperCase();
  return uid;
}

// ═══════════════════════════════════════════════════════════
// SYSTEM ON/OFF
// ═══════════════════════════════════════════════════════════
void activateSystem() {
  systemActive = true;
  Serial.println("System ACTIVATED");

  // เสียงบีพ
  beep(2);

  // LCD: Hello Mr.Kittanan
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Hello Mr.Kittanan");
  lcd.setCursor(0, 1);
  lcd.print("iMARTyBot  ON   ");

  // แจ้ง iMATOMs Platform → พูดเสียง (Web Speech API)
  notifyPlatform("greet");

  // พัดลม: เริ่มหมุนช้า
  setFanSpeed(1);

  // อ่าน DHT ทันที
  delay(2000);
  float t = dht.readTemperature();
  float h = dht.readHumidity();
  if (!isnan(t) && !isnan(h)) {
    lastTemp = t; lastHumi = h;
    updateLCD(t, h);
  }

  lastAPIPost = 0; // force post ทันที
}

void deactivateSystem() {
  systemActive = false;
  Serial.println("System DEACTIVATED");

  beep(1);

  // หยุดพัดลม
  setFanSpeed(0);

  // LCD: Goodbye
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("  Goodbye! :-) ");
  lcd.setCursor(0, 1);
  lcd.print("iMARTyBot  OFF  ");

  // แจ้ง iMATOMs
  notifyPlatform("goodbye");

  delay(2000);
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("  iMARTyBot v1  ");
  lcd.setCursor(0, 1);
  lcd.print("  Scan to Start ");
}

// ═══════════════════════════════════════════════════════════
// FAN SPEED (Continuous Servo: 90=stop, <90=CCW, >90=CW)
// ═══════════════════════════════════════════════════════════
void setFanSpeed(int level) {
  servoSpeed = level;
  switch (level) {
    case 0: fanServo.write(90);  break; // หยุด
    case 1: fanServo.write(100); break; // ช้า
    case 2: fanServo.write(110); break; // กลาง
    case 3: fanServo.write(120); break; // เร็ว
    case 4: fanServo.write(135); break; // เร็วมาก
  }
  Serial.println("Fan speed: " + String(level));
}

// ═══════════════════════════════════════════════════════════
// LCD
// ═══════════════════════════════════════════════════════════
void updateLCD(float t, float h) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("T:" + String(t, 1) + (char)223 + "C  Fan:" + String(servoSpeed));
  lcd.setCursor(0, 1);
  lcd.print("H:" + String(h, 1) + "%  iMATOMs  ");
}

// ═══════════════════════════════════════════════════════════
// BUZZER
// ═══════════════════════════════════════════════════════════
void beep(int times) {
  for (int i = 0; i < times; i++) {
    digitalWrite(BUZZER_PIN, HIGH);
    delay(100);
    digitalWrite(BUZZER_PIN, LOW);
    delay(100);
  }
}
void beepError() {
  digitalWrite(BUZZER_PIN, HIGH);
  delay(500);
  digitalWrite(BUZZER_PIN, LOW);
}

// ═══════════════════════════════════════════════════════════
// NOTIFY iMATOMs PLATFORM (Web Speech trigger)
// ═══════════════════════════════════════════════════════════
void notifyPlatform(String event) {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClient client;
  String body = "{\"device\":\"iMARTyBot\",\"event\":\"" + event + "\","
                "\"user\":\"kittananonsee\",\"temp\":" + String(lastTemp) +
                ",\"humi\":" + String(lastHumi) + "}";
  String req = "POST /iot/martybot HTTP/1.1\r\n"
               "Host: " + String(API_HOST) + "\r\n"
               "Content-Type: application/json\r\n"
               "Content-Length: " + body.length() + "\r\n"
               "Connection: close\r\n\r\n" + body;
  if (client.connect(API_HOST, API_PORT)) {
    client.print(req);
    client.stop();
    Serial.println("Platform notified: " + event);
  }
}

// ═══════════════════════════════════════════════════════════
// POST SENSOR DATA → iMATOMs API
// ═══════════════════════════════════════════════════════════
void postSensorData(float t, float h) {
  if (WiFi.status() != WL_CONNECTED) return;
  WiFiClient client;
  String body = "{\"device_id\":\"iMARTyBot-001\","
                "\"temperature\":" + String(t) + ","
                "\"humidity\":" + String(h) + ","
                "\"fan_speed\":" + String(servoSpeed) + ","
                "\"status\":\"" + (systemActive?"active":"idle") + "\"}";
  String req = "POST /iot/sensor HTTP/1.1\r\n"
               "Host: " + String(API_HOST) + "\r\n"
               "Content-Type: application/json\r\n"
               "Content-Length: " + body.length() + "\r\n"
               "Connection: close\r\n\r\n" + body;
  if (client.connect(API_HOST, API_PORT)) {
    client.print(req);
    client.stop();
    Serial.println("Sensor data posted");
  }
}

// ═══════════════════════════════════════════════════════════
// WEB SERVER HANDLERS (iMATOMs Dashboard ดึงข้อมูลได้)
// ═══════════════════════════════════════════════════════════
void handleStatus() {
  String json = "{\"active\":" + String(systemActive?"true":"false") +
                ",\"fan_speed\":" + String(servoSpeed) +
                ",\"ip\":\"" + WiFi.localIP().toString() + "\"}";
  server.send(200, "application/json", json);
}

void handleSensor() {
  String json = "{\"temperature\":" + String(lastTemp) +
                ",\"humidity\":" + String(lastHumi) +
                ",\"fan_speed\":" + String(servoSpeed) +
                ",\"active\":" + String(systemActive?"true":"false") + "}";
  server.send(200, "application/json", json);
}

void handleControl() {
  if (!server.hasArg("plain")) { server.send(400); return; }
  String body = server.arg("plain");
  StaticJsonDocument<200> doc;
  if (deserializeJson(doc, body) == DeserializationError::Ok) {
    if (doc.containsKey("fan_speed")) {
      int spd = doc["fan_speed"];
      setFanSpeed(constrain(spd, 0, 4));
    }
  }
  server.send(200, "application/json", "{\"ok\":true}");
}
