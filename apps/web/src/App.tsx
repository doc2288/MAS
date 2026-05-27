import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as QRCode from "qrcode";
import {
  decryptBytes,
  decryptMessage,
  encryptBytes,
  encryptMessage,
  fromBase64,
  generateKeyPair,
  toBase64
} from "@mas/shared";
import {
  getCountries,
  getCountryCallingCode,
  isValidPhoneNumber
} from "libphonenumber-js";

type User = {
  id: string;
  phone: string;
  login?: string;
  publicKey?: string;
  status?: string;
};

type UiMessage = {
  id: string;
  from: string;
  to: string;
  createdAt: string;
  contentType: "text" | "file" | "emoji" | "sticker" | "gif" | "voice";
  text?: string;
  meta?: Record<string, string>;
  isMine: boolean;
  status?: "sent" | "delivered" | "read";
  replyToId?: string;
  editedAt?: string;
  pinned?: boolean;
  reactions?: Record<string, string[]>;
};

type ChatSummary = {
  peerId: string;
  peerPhone: string;
  peerLogin?: string;
  peerPublicKey?: string;
  lastMessageAt: string;
  lastContentType: UiMessage["contentType"];
};

type CallState = {
  status: "idle" | "calling" | "incoming" | "in-call";
  offer?: RTCSessionDescriptionInit;
  callerId?: string;
  pc?: RTCPeerConnection;
  remoteStream?: MediaStream;
  localStream?: MediaStream;
  isVideo?: boolean;
};

type KeyPairState = { publicKey: string; secretKey: string };

type KeyBackupPayload = {
  ciphertext: string;
  salt: string;
  nonce: string;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  updatedAt?: string;
};

type KeyBackupResponse = {
  publicKey: string;
  backup: KeyBackupPayload;
};

type Lang = "en" | "ru" | "uk" | "no";
type TranslationKey =
  | "appName" | "authSubtitle" | "countrySearch" | "nothingFound" | "phoneNumber" | "fullNumber"
  | "requestCode" | "devCode" | "code" | "signIn" | "chatsSearch" | "people" | "noChats"
  | "file" | "sticker" | "emoji" | "encryptedMessage" | "settings" | "program" | "notifications"
  | "language" | "account" | "login" | "loginPlaceholder" | "uniqueLogin" | "save"
  | "phone" | "session" | "logout" | "keys" | "backup" | "available" | "notCreated"
  | "masPin" | "saveKey" | "restorePin" | "restoreKey" | "privacy" | "readReceipts"
  | "typingIndicator" | "search" | "searchChat" | "clearChat" | "videoCall" | "audioCall"
  | "online" | "typing" | "incomingVideoCall" | "incomingCall" | "accept" | "decline"
  | "activeCall" | "end" | "chatPlaceholder" | "found" | "you" | "delete" | "reply"
  | "edit" | "copy" | "pin" | "unpin" | "emojiSearch" | "editing" | "edited" | "message"
  | "attachFile" | "pinnedMessage" | "noKeysEncrypted" | "wrongKeyEncrypted" | "loginRequired"
  | "loginTaken" | "loginSaveFailed" | "loginUpdated" | "networkError" | "backupFound"
  | "keysNotReady" | "pinTooShort" | "backupSaveFailed" | "backupSaved" | "backupEncryptFailed"
  | "backupPinRequired" | "backupMissing" | "keyRestored" | "keyRestoreFailed"
  | "invalidPhone" | "codeSentDev" | "codeSent" | "authSuccess" | "wrongCode"
  | "userNotFound" | "contactAdded" | "chooseChat" | "noConnection" | "peerNoPublicKey"
  | "copied" | "clearPrompt" | "clearBothConfirm" | "clearFailed" | "chatCleared"
  | "uploadFailed" | "fileUnavailable" | "fileDecryptFailed" | "callWindowTitle"
  | "subscriber" | "microphone" | "camera" | "screenShare" | "fullscreen" | "screen"
  | "screenSharing" | "call" | "connecting" | "videoCallUpper" | "audioCallUpper"
  | "activeCallStatus" | "calling" | "cameraEnableFailed" | "callStartFailed"
  | "peerMissing" | "callAcceptFailed" | "notificationPermissionDenied" | "notificationUnsupported"
  | "notificationTitle";

const translations: Record<Lang, Record<TranslationKey, string>> = {
  en: {
    appName: "MAS Secure", authSubtitle: "Sign in with your phone number (SMS).",
    countrySearch: "Search country or code", nothingFound: "Nothing found", phoneNumber: "Phone number",
    fullNumber: "Full number", requestCode: "Get code", devCode: "Dev code", code: "Code", signIn: "Sign in",
    chatsSearch: "Search chats", people: "People", noChats: "No chats found", file: "File", sticker: "Sticker",
    emoji: "Emoji", encryptedMessage: "Encrypted message", settings: "Settings", program: "App",
    notifications: "Notifications", language: "Language", account: "Account", login: "Login",
    loginPlaceholder: "for example: mas_user", uniqueLogin: "Unique login", save: "Save", phone: "Phone number",
    session: "Session", logout: "Log out", keys: "Keys", backup: "Backup", available: "Available",
    notCreated: "Not created", masPin: "MAS PIN", saveKey: "Save key", restorePin: "Restore PIN",
    restoreKey: "Restore key", privacy: "Privacy", readReceipts: "Read receipts", typingIndicator: "Typing indicator",
    search: "Search", searchChat: "Search in chat", clearChat: "Clear chat", videoCall: "Video call",
    audioCall: "Call", online: "online", typing: "typing...", incomingVideoCall: "Incoming video call",
    incomingCall: "Incoming call", accept: "Accept", decline: "Decline", activeCall: "Call active", end: "End",
    chatPlaceholder: "Choose a chat or find a contact with search", found: "found", you: "You", delete: "Delete",
    reply: "Reply", edit: "Edit", copy: "Copy", pin: "Pin", unpin: "Unpin", emojiSearch: "Search emoji...",
    editing: "Editing", edited: "edited", message: "Message", attachFile: "Upload file", pinnedMessage: "pinned message",
    noKeysEncrypted: "No encryption keys", wrongKeyEncrypted: "Message was encrypted with another key",
    loginRequired: "Enter a login.", loginTaken: "Login is already taken.", loginSaveFailed: "Could not save login.",
    loginUpdated: "Login updated.", networkError: "Network error.", backupFound: "Key backup found. Enter your MAS PIN in Settings to restore it.",
    keysNotReady: "Keys are not initialized.", pinTooShort: "MAS PIN must contain at least 8 characters.",
    backupSaveFailed: "Could not save key backup.", backupSaved: "Key backup saved.",
    backupEncryptFailed: "Could not encrypt key backup.", backupPinRequired: "Enter the MAS PIN for the backup.",
    backupMissing: "Key backup was not found.", keyRestored: "Key restored.",
    keyRestoreFailed: "Could not restore key. Check your MAS PIN.", invalidPhone: "Invalid phone number.",
    codeSentDev: "Code sent (dev).", codeSent: "Code sent.", authSuccess: "Signed in successfully.",
    wrongCode: "The code is incorrect.", userNotFound: "User not found.", contactAdded: "Contact added.",
    chooseChat: "Choose a chat.", noConnection: "No connection.", peerNoPublicKey: "The contact has no public key.",
    copied: "Copied.", clearPrompt: "Clear chat: type \"me\" to delete only for yourself or \"both\" to delete for both participants.",
    clearBothConfirm: "Delete the whole chat for both participants? This cannot be undone.",
    clearFailed: "Could not clear chat.", chatCleared: "Chat cleared.", uploadFailed: "File upload failed.",
    fileUnavailable: "File unavailable.", fileDecryptFailed: "Could not decrypt file.", callWindowTitle: "MAS - Call",
    subscriber: "Contact", microphone: "Microphone", camera: "Camera", screenShare: "Screen sharing",
    fullscreen: "Fullscreen", screen: "Screen", screenSharing: "Screen sharing", call: "Call", connecting: "Connecting...",
    videoCallUpper: "VIDEO CALL", audioCallUpper: "AUDIO CALL", activeCallStatus: "Active call", calling: "Calling...",
    cameraEnableFailed: "Could not enable camera.", callStartFailed: "Could not start the call. Check microphone access.",
    peerMissing: "Contact data is missing.", callAcceptFailed: "Could not accept the call. Check microphone access.",
    notificationPermissionDenied: "Browser notifications are blocked.", notificationUnsupported: "This browser does not support notifications.",
    notificationTitle: "New message"
  },
  ru: {
    appName: "MAS Secure", authSubtitle: "Вход по номеру телефона (SMS).",
    countrySearch: "Поиск страны или кода", nothingFound: "Ничего не найдено", phoneNumber: "Номер",
    fullNumber: "Полный номер", requestCode: "Получить код", devCode: "Dev-код", code: "Код", signIn: "Войти",
    chatsSearch: "Поиск чатов", people: "Люди", noChats: "Чаты не найдены", file: "Файл", sticker: "Стикер",
    emoji: "Эмодзи", encryptedMessage: "Зашифрованное сообщение", settings: "Настройки", program: "Приложение",
    notifications: "Уведомления", language: "Язык", account: "Аккаунт", login: "Логин",
    loginPlaceholder: "например: mas_user", uniqueLogin: "Уникальный логин", save: "Сохранить", phone: "Номер телефона",
    session: "Сеанс", logout: "Выйти", keys: "Ключи", backup: "Резервная копия", available: "Доступна",
    notCreated: "Не создана", masPin: "MAS PIN", saveKey: "Сохранить ключ", restorePin: "PIN для восстановления",
    restoreKey: "Восстановить ключ", privacy: "Приватность", readReceipts: "Отчёты о прочтении", typingIndicator: "Индикатор набора",
    search: "Поиск", searchChat: "Поиск в чате", clearChat: "Очистить чат", videoCall: "Видеозвонок",
    audioCall: "Звонок", online: "онлайн", typing: "печатает...", incomingVideoCall: "Входящий видеозвонок",
    incomingCall: "Входящий звонок", accept: "Принять", decline: "Отклонить", activeCall: "Звонок активен", end: "Завершить",
    chatPlaceholder: "Выберите чат или найдите контакт через поиск", found: "найдено", you: "Вы", delete: "Удалить",
    reply: "Ответить", edit: "Редактировать", copy: "Копировать", pin: "Закрепить", unpin: "Открепить", emojiSearch: "Поиск эмодзи...",
    editing: "Редактирование", edited: "ред.", message: "Сообщение", attachFile: "Загрузить файл", pinnedMessage: "закреплённое сообщение",
    noKeysEncrypted: "Нет ключей шифрования", wrongKeyEncrypted: "Сообщение зашифровано другим ключом",
    loginRequired: "Укажите логин.", loginTaken: "Логин уже занят.", loginSaveFailed: "Не удалось сохранить логин.",
    loginUpdated: "Логин обновлён.", networkError: "Ошибка сети.", backupFound: "Найдена резервная копия ключа. Введите MAS PIN в настройках, чтобы восстановить её.",
    keysNotReady: "Ключи не инициализированы.", pinTooShort: "MAS PIN должен содержать минимум 8 символов.",
    backupSaveFailed: "Не удалось сохранить резервную копию ключа.", backupSaved: "Резервная копия ключа сохранена.",
    backupEncryptFailed: "Не удалось зашифровать резервную копию ключа.", backupPinRequired: "Введите MAS PIN для резервной копии.",
    backupMissing: "Резервная копия ключа не найдена.", keyRestored: "Ключ восстановлен.",
    keyRestoreFailed: "Не удалось восстановить ключ. Проверьте MAS PIN.", invalidPhone: "Неверный номер телефона.",
    codeSentDev: "Код отправлен (dev).", codeSent: "Код отправлен.", authSuccess: "Авторизация успешна.",
    wrongCode: "Код неверный.", userNotFound: "Пользователь не найден.", contactAdded: "Контакт добавлен.",
    chooseChat: "Выберите чат.", noConnection: "Нет соединения.", peerNoPublicKey: "У контакта нет публичного ключа.",
    copied: "Скопировано.", clearPrompt: "Очистить чат: введите \"me\", чтобы удалить только у себя, или \"both\", чтобы удалить у обоих участников.",
    clearBothConfirm: "Удалить весь чат у обоих участников? Это действие нельзя отменить.",
    clearFailed: "Ошибка очистки чата.", chatCleared: "Чат очищен.", uploadFailed: "Ошибка загрузки файла.",
    fileUnavailable: "Файл недоступен.", fileDecryptFailed: "Не удалось расшифровать файл.", callWindowTitle: "MAS - Звонок",
    subscriber: "Абонент", microphone: "Микрофон", camera: "Камера", screenShare: "Демонстрация экрана",
    fullscreen: "На весь экран", screen: "Экран", screenSharing: "Демонстрация экрана", call: "Звонок", connecting: "Соединение...",
    videoCallUpper: "ВИДЕОЗВОНОК", audioCallUpper: "АУДИОЗВОНОК", activeCallStatus: "Активный звонок", calling: "Вызов...",
    cameraEnableFailed: "Не удалось включить камеру.", callStartFailed: "Не удалось запустить звонок. Проверьте доступ к микрофону.",
    peerMissing: "Нет данных собеседника.", callAcceptFailed: "Не удалось принять звонок. Проверьте доступ к микрофону.",
    notificationPermissionDenied: "Уведомления браузера заблокированы.", notificationUnsupported: "Этот браузер не поддерживает уведомления.",
    notificationTitle: "Новое сообщение"
  },
  uk: {
    appName: "MAS Secure", authSubtitle: "Вхід за номером телефону (SMS).",
    countrySearch: "Пошук країни або коду", nothingFound: "Нічого не знайдено", phoneNumber: "Номер",
    fullNumber: "Повний номер", requestCode: "Отримати код", devCode: "Dev-код", code: "Код", signIn: "Увійти",
    chatsSearch: "Пошук чатів", people: "Люди", noChats: "Чатів не знайдено", file: "Файл", sticker: "Стікер",
    emoji: "Емодзі", encryptedMessage: "Зашифроване повідомлення", settings: "Налаштування", program: "Програма",
    notifications: "Сповіщення", language: "Мова", account: "Акаунт", login: "Логін",
    loginPlaceholder: "наприклад: mas_user", uniqueLogin: "Унікальний логін", save: "Зберегти", phone: "Номер телефону",
    session: "Сеанс", logout: "Вийти", keys: "Ключі", backup: "Резервна копія", available: "Доступна",
    notCreated: "Не створена", masPin: "MAS PIN", saveKey: "Зберегти ключ", restorePin: "PIN для відновлення",
    restoreKey: "Відновити ключ", privacy: "Конфіденційність", readReceipts: "Звіти про прочитання", typingIndicator: "Індикатор набору",
    search: "Пошук", searchChat: "Пошук в чаті", clearChat: "Очистити чат", videoCall: "Відеодзвінок",
    audioCall: "Дзвінок", online: "онлайн", typing: "друкує...", incomingVideoCall: "Вхідний відеодзвінок",
    incomingCall: "Вхідний дзвінок", accept: "Прийняти", decline: "Відхилити", activeCall: "Дзвінок активний", end: "Завершити",
    chatPlaceholder: "Оберіть чат або знайдіть контакт через пошук", found: "знайдено", you: "Ви", delete: "Видалити",
    reply: "Відповісти", edit: "Редагувати", copy: "Копіювати", pin: "Закріпити", unpin: "Відкріпити", emojiSearch: "Пошук емодзі...",
    editing: "Редагування", edited: "ред.", message: "Повідомлення", attachFile: "Завантажити файл", pinnedMessage: "закріплене повідомлення",
    noKeysEncrypted: "Немає ключів шифрування", wrongKeyEncrypted: "Повідомлення зашифроване іншим ключем",
    loginRequired: "Вкажіть логін.", loginTaken: "Логін уже зайнятий.", loginSaveFailed: "Не вдалося зберегти логін.",
    loginUpdated: "Логін оновлено.", networkError: "Помилка мережі.", backupFound: "Знайдено резервну копію ключа. Введіть MAS PIN у налаштуваннях, щоб відновити її.",
    keysNotReady: "Ключі не ініціалізовані.", pinTooShort: "MAS PIN має містити щонайменше 8 символів.",
    backupSaveFailed: "Не вдалося зберегти резервну копію ключа.", backupSaved: "Резервну копію ключа збережено.",
    backupEncryptFailed: "Не вдалося зашифрувати резервну копію ключа.", backupPinRequired: "Введіть MAS PIN для резервної копії.",
    backupMissing: "Резервну копію ключа не знайдено.", keyRestored: "Ключ відновлено.",
    keyRestoreFailed: "Не вдалося відновити ключ. Перевірте MAS PIN.", invalidPhone: "Невірний номер телефону.",
    codeSentDev: "Код надіслано (dev).", codeSent: "Код надіслано.", authSuccess: "Авторизація успішна.",
    wrongCode: "Код невірний.", userNotFound: "Користувача не знайдено.", contactAdded: "Контакт додано.",
    chooseChat: "Оберіть чат.", noConnection: "Немає з'єднання.", peerNoPublicKey: "У контакта немає публічного ключа.",
    copied: "Скопійовано.", clearPrompt: "Очистити чат: введіть \"me\" для видалення лише у себе або \"both\" для видалення у двох учасників.",
    clearBothConfirm: "Видалити весь чат у двох учасників? Цю дію не можна скасувати.",
    clearFailed: "Помилка очищення чату.", chatCleared: "Чат очищено.", uploadFailed: "Помилка завантаження файлу.",
    fileUnavailable: "Файл недоступний.", fileDecryptFailed: "Не вдалося розшифрувати файл.", callWindowTitle: "MAS - Дзвінок",
    subscriber: "Абонент", microphone: "Мікрофон", camera: "Камера", screenShare: "Демонстрація екрану",
    fullscreen: "На весь екран", screen: "Екран", screenSharing: "Трансляція екрану", call: "Дзвінок", connecting: "З'єднання...",
    videoCallUpper: "ВІДЕОДЗВІНОК", audioCallUpper: "АУДІОДЗВІНОК", activeCallStatus: "Активний дзвінок", calling: "Виклик...",
    cameraEnableFailed: "Не вдалося увімкнути камеру.", callStartFailed: "Не вдалося запустити дзвінок. Перевірте доступ до мікрофона.",
    peerMissing: "Немає даних співрозмовника.", callAcceptFailed: "Не вдалося прийняти дзвінок. Перевірте доступ до мікрофона.",
    notificationPermissionDenied: "Сповіщення браузера заблоковані.", notificationUnsupported: "Цей браузер не підтримує сповіщення.",
    notificationTitle: "Нове повідомлення"
  },
  no: {
    appName: "MAS Secure", authSubtitle: "Logg inn med telefonnummer (SMS).",
    countrySearch: "Søk etter land eller kode", nothingFound: "Ingen treff", phoneNumber: "Telefonnummer",
    fullNumber: "Fullt nummer", requestCode: "Hent kode", devCode: "Dev-kode", code: "Kode", signIn: "Logg inn",
    chatsSearch: "Søk i chatter", people: "Personer", noChats: "Ingen chatter funnet", file: "Fil", sticker: "Klistremerke",
    emoji: "Emoji", encryptedMessage: "Kryptert melding", settings: "Innstillinger", program: "App",
    notifications: "Varsler", language: "Språk", account: "Konto", login: "Brukernavn",
    loginPlaceholder: "for eksempel: mas_user", uniqueLogin: "Unikt brukernavn", save: "Lagre", phone: "Telefonnummer",
    session: "Økt", logout: "Logg ut", keys: "Nøkler", backup: "Sikkerhetskopi", available: "Tilgjengelig",
    notCreated: "Ikke opprettet", masPin: "MAS PIN", saveKey: "Lagre nøkkel", restorePin: "PIN for gjenoppretting",
    restoreKey: "Gjenopprett nøkkel", privacy: "Personvern", readReceipts: "Lesebekreftelser", typingIndicator: "Skriveindikator",
    search: "Søk", searchChat: "Søk i chat", clearChat: "Tøm chat", videoCall: "Videosamtale",
    audioCall: "Samtale", online: "pålogget", typing: "skriver...", incomingVideoCall: "Innkommende videosamtale",
    incomingCall: "Innkommende samtale", accept: "Svar", decline: "Avvis", activeCall: "Samtale aktiv", end: "Avslutt",
    chatPlaceholder: "Velg en chat eller finn en kontakt med søk", found: "funnet", you: "Du", delete: "Slett",
    reply: "Svar", edit: "Rediger", copy: "Kopier", pin: "Fest", unpin: "Løsne", emojiSearch: "Søk etter emoji...",
    editing: "Redigering", edited: "red.", message: "Melding", attachFile: "Last opp fil", pinnedMessage: "festet melding",
    noKeysEncrypted: "Ingen krypteringsnøkler", wrongKeyEncrypted: "Meldingen ble kryptert med en annen nøkkel",
    loginRequired: "Skriv inn brukernavn.", loginTaken: "Brukernavnet er opptatt.", loginSaveFailed: "Kunne ikke lagre brukernavn.",
    loginUpdated: "Brukernavn oppdatert.", networkError: "Nettverksfeil.", backupFound: "Nøkkelsikkerhetskopi funnet. Skriv inn MAS PIN i Innstillinger for å gjenopprette den.",
    keysNotReady: "Nøkler er ikke initialisert.", pinTooShort: "MAS PIN må inneholde minst 8 tegn.",
    backupSaveFailed: "Kunne ikke lagre nøkkelsikkerhetskopi.", backupSaved: "Nøkkelsikkerhetskopi lagret.",
    backupEncryptFailed: "Kunne ikke kryptere nøkkelsikkerhetskopi.", backupPinRequired: "Skriv inn MAS PIN for sikkerhetskopien.",
    backupMissing: "Nøkkelsikkerhetskopi ble ikke funnet.", keyRestored: "Nøkkel gjenopprettet.",
    keyRestoreFailed: "Kunne ikke gjenopprette nøkkel. Sjekk MAS PIN.", invalidPhone: "Ugyldig telefonnummer.",
    codeSentDev: "Kode sendt (dev).", codeSent: "Kode sendt.", authSuccess: "Innlogging vellykket.",
    wrongCode: "Koden er feil.", userNotFound: "Bruker ikke funnet.", contactAdded: "Kontakt lagt til.",
    chooseChat: "Velg en chat.", noConnection: "Ingen forbindelse.", peerNoPublicKey: "Kontakten har ingen offentlig nøkkel.",
    copied: "Kopiert.", clearPrompt: "Tøm chat: skriv \"me\" for å slette bare hos deg eller \"both\" for å slette hos begge deltakere.",
    clearBothConfirm: "Slette hele chatten hos begge deltakere? Dette kan ikke angres.",
    clearFailed: "Kunne ikke tømme chat.", chatCleared: "Chat tømt.", uploadFailed: "Filopplasting feilet.",
    fileUnavailable: "Fil utilgjengelig.", fileDecryptFailed: "Kunne ikke dekryptere fil.", callWindowTitle: "MAS - Samtale",
    subscriber: "Kontakt", microphone: "Mikrofon", camera: "Kamera", screenShare: "Skjermdeling",
    fullscreen: "Fullskjerm", screen: "Skjerm", screenSharing: "Skjermdeling", call: "Samtale", connecting: "Kobler til...",
    videoCallUpper: "VIDEOSAMTALE", audioCallUpper: "LYDSAMTALE", activeCallStatus: "Aktiv samtale", calling: "Ringer...",
    cameraEnableFailed: "Kunne ikke slå på kamera.", callStartFailed: "Kunne ikke starte samtalen. Sjekk mikrofontilgang.",
    peerMissing: "Kontaktdata mangler.", callAcceptFailed: "Kunne ikke svare på samtalen. Sjekk mikrofontilgang.",
    notificationPermissionDenied: "Nettleservarsler er blokkert.", notificationUnsupported: "Denne nettleseren støtter ikke varsler.",
    notificationTitle: "Ny melding"
  }
};

const languageLabels: Record<Lang, string> = {
  en: "English",
  ru: "Русский",
  uk: "Українська",
  no: "Norsk"
};
const languageOptions: Lang[] = ["en", "ru", "uk", "no"];

type AuthStep = "language" | "method" | "phone" | "code" | "qr";
type AuthFlowKey =
  | "chooseLanguage"
  | "next"
  | "back"
  | "chooseSignIn"
  | "phoneMethod"
  | "phoneMethodHint"
  | "qrMethod"
  | "qrMethodHint"
  | "confirmPhone"
  | "codeTitle"
  | "codeHint"
  | "changePhone"
  | "qrTitle"
  | "qrHint"
  | "qrWaiting"
  | "qrExpired"
  | "qrRetry"
  | "qrStartFailed"
  | "qrApproved"
  | "qrInvalid";

const authFlowText: Record<Lang, Record<AuthFlowKey, string>> = {
  en: {
    chooseLanguage: "Choose your language",
    next: "Next",
    back: "Back",
    chooseSignIn: "Choose how to sign in",
    phoneMethod: "Phone number",
    phoneMethodHint: "Get an SMS code for this device.",
    qrMethod: "QR code",
    qrMethodHint: "Approve this login from your mobile MAS app.",
    confirmPhone: "Confirm phone",
    codeTitle: "Enter the code",
    codeHint: "We sent a one-time code to your phone.",
    changePhone: "Change phone",
    qrTitle: "Scan with MAS Mobile",
    qrHint: "Open MAS on your phone and approve this login.",
    qrWaiting: "Waiting for mobile approval...",
    qrExpired: "QR code expired.",
    qrRetry: "Create new QR",
    qrStartFailed: "Could not create QR login.",
    qrApproved: "QR approved. Signing in...",
    qrInvalid: "QR login is no longer available."
  },
  ru: {
    chooseLanguage: "Выберите язык",
    next: "Далее",
    back: "Назад",
    chooseSignIn: "Выберите способ входа",
    phoneMethod: "Номер телефона",
    phoneMethodHint: "Получить SMS-код для этого устройства.",
    qrMethod: "QR-код",
    qrMethodHint: "Подтвердить вход в мобильном MAS.",
    confirmPhone: "Подтвердить номер",
    codeTitle: "Введите код",
    codeHint: "Мы отправили одноразовый код на ваш телефон.",
    changePhone: "Изменить номер",
    qrTitle: "Сканируйте в MAS Mobile",
    qrHint: "Откройте MAS на телефоне и подтвердите этот вход.",
    qrWaiting: "Ожидаем подтверждение с телефона...",
    qrExpired: "QR-код истёк.",
    qrRetry: "Создать новый QR",
    qrStartFailed: "Не удалось создать QR-вход.",
    qrApproved: "QR подтверждён. Выполняем вход...",
    qrInvalid: "QR-вход больше недоступен."
  },
  uk: {
    chooseLanguage: "Оберіть мову",
    next: "Далі",
    back: "Назад",
    chooseSignIn: "Оберіть спосіб входу",
    phoneMethod: "Номер телефону",
    phoneMethodHint: "Отримати SMS-код для цього пристрою.",
    qrMethod: "QR-код",
    qrMethodHint: "Підтвердити вхід у мобільному MAS.",
    confirmPhone: "Підтвердити номер",
    codeTitle: "Введіть код",
    codeHint: "Ми надіслали одноразовий код на ваш телефон.",
    changePhone: "Змінити номер",
    qrTitle: "Скануйте в MAS Mobile",
    qrHint: "Відкрийте MAS на телефоні та підтвердьте цей вхід.",
    qrWaiting: "Очікуємо підтвердження з телефона...",
    qrExpired: "QR-код минув.",
    qrRetry: "Створити новий QR",
    qrStartFailed: "Не вдалося створити QR-вхід.",
    qrApproved: "QR підтверджено. Виконуємо вхід...",
    qrInvalid: "QR-вхід більше недоступний."
  },
  no: {
    chooseLanguage: "Velg språk",
    next: "Neste",
    back: "Tilbake",
    chooseSignIn: "Velg innloggingsmåte",
    phoneMethod: "Telefonnummer",
    phoneMethodHint: "Få en SMS-kode for denne enheten.",
    qrMethod: "QR-kode",
    qrMethodHint: "Godkjenn innloggingen fra MAS på mobilen.",
    confirmPhone: "Bekreft telefon",
    codeTitle: "Skriv inn koden",
    codeHint: "Vi sendte en engangskode til telefonen.",
    changePhone: "Endre telefon",
    qrTitle: "Skann med MAS Mobile",
    qrHint: "Åpne MAS på telefonen og godkjenn denne innloggingen.",
    qrWaiting: "Venter på mobilgodkjenning...",
    qrExpired: "QR-koden er utløpt.",
    qrRetry: "Lag ny QR",
    qrStartFailed: "Kunne ikke opprette QR-innlogging.",
    qrApproved: "QR godkjent. Logger inn...",
    qrInvalid: "QR-innloggingen er ikke lenger tilgjengelig."
  }
};

const loadLang = (): Lang => {
  const raw = localStorage.getItem("mas.lang");
  return raw === "ru" || raw === "uk" || raw === "no" || raw === "en" ? raw : "en";
};

const loadBool = (key: string, fallback: boolean) => {
  const raw = localStorage.getItem(key);
  if (raw === "true") return true;
  if (raw === "false") return false;
  return fallback;
};

const SERVER_PORT = "4000";
const SERVER_HOST = typeof window !== "undefined" && window.location.hostname
  ? window.location.hostname
  : "localhost";
const isHttps = typeof window !== "undefined" && window.location.protocol === "https:";
const defaultApiUrl = `${isHttps ? "https" : "http"}://${SERVER_HOST}:${SERVER_PORT}`;
const defaultWsUrl = `${isHttps ? "wss" : "ws"}://${SERVER_HOST}:${SERVER_PORT}`;
const viteEnv = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const lsApi = typeof localStorage !== "undefined" ? localStorage.getItem("mas.apiUrl")?.trim() : null;
const lsWs = typeof localStorage !== "undefined" ? localStorage.getItem("mas.wsUrl")?.trim() : null;
const API_URL = (lsApi || viteEnv.VITE_API_URL?.trim() || defaultApiUrl).replace(/\/+$/, "");
const WS_URL = (lsWs || viteEnv.VITE_WS_URL?.trim() || defaultWsUrl).replace(/\/+$/, "");
const KEY_BACKUP_ITERATIONS = 150_000;
const emojiCategories: Record<string, string[]> = {
  "Обличчя": ["😀","😂","🤣","😍","🥰","😘","😎","🤩","🥳","😏","🤔","🙄","😴","🤯","🥺","😤","😭","😱","🤗","😇"],
  "Жести": ["👍","👎","👋","🤝","🙏","💪","✌️","🤟","👏","🫶","☝️","👆","👇","👉","👈","✋","🤚","🖖","🫡","🫰"],
  "Серця": ["❤️","🧡","💛","💚","💙","💜","🖤","🤍","💔","❤️‍🔥","💕","💖","💗","💘","💝","♥️","🫀","💟","❣️","💞"],
  "Об'єкти": ["🔥","⭐","✨","💫","🌟","🎉","🎊","🎁","🏆","🥇","💎","🔑","💡","📌","📎","✏️","📝","💬","🔒","🚀"],
  "Символи": ["✅","❌","⚠️","💯","♻️","🔄","➡️","⬅️","⬆️","⬇️","▶️","⏸️","🔴","🟢","🔵","⚪","⚫","🟡","🟣","🟠"]
};
const allEmojis = Object.values(emojiCategories).flat();

const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

const formatDate = (iso: string, lang: Lang) => {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === today.toDateString()) {
    return { en: "Today", ru: "Сегодня", uk: "Сьогодні", no: "I dag" }[lang];
  }
  if (d.toDateString() === yesterday.toDateString()) {
    return { en: "Yesterday", ru: "Вчера", uk: "Вчора", no: "I går" }[lang];
  }
  const locale = { en: "en-US", ru: "ru-RU", uk: "uk-UA", no: "nb-NO" }[lang];
  return d.toLocaleDateString(locale, { day: "numeric", month: "long", year: "numeric" });
};

const loadStoredKeys = (): KeyPairState | null => {
  try {
    const raw = localStorage.getItem("mas.keys");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<KeyPairState>;
    return typeof parsed.publicKey === "string" && typeof parsed.secretKey === "string"
      ? { publicKey: parsed.publicKey, secretKey: parsed.secretKey }
      : null;
  } catch {
    localStorage.removeItem("mas.keys");
    return null;
  }
};

const asArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

const deriveBackupKey = async (pin: string, salt: Uint8Array, iterations: number) => {
  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(pin),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: asArrayBuffer(salt), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
};

const createKeyBackupPayload = async (keys: KeyPairState, pin: string): Promise<KeyBackupPayload> => {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(pin, salt, KEY_BACKUP_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(nonce) },
    key,
    encoder.encode(keys.secretKey)
  );
  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    salt: toBase64(salt),
    nonce: toBase64(nonce),
    kdf: "PBKDF2-SHA256",
    iterations: KEY_BACKUP_ITERATIONS
  };
};

const restoreKeysFromBackup = async (publicKey: string, backup: KeyBackupPayload, pin: string): Promise<KeyPairState> => {
  const key = await deriveBackupKey(pin, fromBase64(backup.salt), backup.iterations);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(fromBase64(backup.nonce)) },
    key,
    asArrayBuffer(fromBase64(backup.ciphertext))
  );
  return {
    publicKey,
    secretKey: new TextDecoder().decode(plaintext)
  };
};

const notifSound = (() => {
  let ctx: AudioContext | null = null;
  return () => {
    try {
      if (!ctx) ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 800;
      gain.gain.value = 0.12;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
      osc.stop(ctx.currentTime + 0.15);
    } catch { /* ignore */ }
  };
})();

export default function App() {
  const defaultCountry = useMemo(() => {
    const region = navigator.language.split("-")[1] ?? "US";
    const available = getCountries();
    return available.includes(region as any) ? region : "US";
  }, []);
  const [country, setCountry] = useState(defaultCountry);
  const [countryOpen, setCountryOpen] = useState(false);
  const [countryQuery, setCountryQuery] = useState("");
  const [localNumber, setLocalNumber] = useState("");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState("");
  const [token, setToken] = useState<string | null>(localStorage.getItem("mas.token"));
  const [user, setUser] = useState<User | null>(null);
  const [keys, setKeys] = useState<KeyPairState | null>(() => loadStoredKeys());
  const [language, setLanguage] = useState<Lang>(() => loadLang());
  const [authStep, setAuthStep] = useState<AuthStep>("language");
  const [qrSession, setQrSession] = useState<{
    id: string;
    secret: string;
    payload: string;
    expiresAt: string;
  } | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [peer, setPeer] = useState<User | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [chatList, setChatList] = useState<ChatSummary[]>([]);
  const [status, setStatus] = useState("");
  const t = useCallback((key: TranslationKey) => translations[language][key], [language]);
  const ta = useCallback((key: AuthFlowKey) => authFlowText[language][key], [language]);
  
  const [activeTab, setActiveTab] = useState<"chat" | "settings">("chat");
  const [isMenuOpen, setIsMenuOpen] = useState(true);
  const [chatQuery, setChatQuery] = useState("");
  const [loginValue, setLoginValue] = useState("");
  const [loginMatches, setLoginMatches] = useState<User[]>([]);
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => loadBool("mas.notifications", true));
  const [readReceipts, setReadReceipts] = useState(() => loadBool("mas.readReceipts", true));
  const [typingIndicator, setTypingIndicator] = useState(() => loadBool("mas.typingIndicator", true));
  const [call, setCall] = useState<CallState>({ status: "idle" });
  const [peerTyping, setPeerTyping] = useState(false);
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [showEmoji, setShowEmoji] = useState(false);
  const [msgInput, setMsgInput] = useState("");
  const [unreadMap, setUnreadMap] = useState<Record<string, number>>({});
  const [replyTo, setReplyTo] = useState<UiMessage | null>(null);
  const [editingMsg, setEditingMsg] = useState<UiMessage | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; msg: UiMessage } | null>(null);
  const [chatSearch, setChatSearch] = useState("");
  const [chatSearchOpen, setChatSearchOpen] = useState(false);
  const [reactionPicker, setReactionPicker] = useState<string | null>(null);
  const [emojiCategory, setEmojiCategory] = useState("Обличчя");
  const [emojiSearch, setEmojiSearch] = useState("");
  const [backupPin, setBackupPin] = useState("");
  const [restorePin, setRestorePin] = useState("");
  const [backupAvailable, setBackupAvailable] = useState(false);
  const quickReactions = ["👍","❤️","😂","😮","😢","🔥","🚀"];

  const wsRef = useRef<WebSocket | null>(null);
  const shouldReconnectRef = useRef(false);
  const reconnectTimer = useRef<number | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const callWindowRef = useRef<Window | null>(null);
  const callWindowPartsRef = useRef<{
    localVideo?: HTMLVideoElement;
    remoteVideo?: HTMLVideoElement;
    label?: HTMLDivElement;
    peerName?: HTMLDivElement;
    statusLabel?: HTMLDivElement;
    timerLabel?: HTMLDivElement;
    avatar?: HTMLDivElement;
    micBtn?: HTMLButtonElement;
    camBtn?: HTMLButtonElement;
    fullscreenBtn?: HTMLButtonElement;
    timerInterval?: number;
    timerStartTime?: number;
  } | null>(null);
  const toneCtxRef = useRef<AudioContext | null>(null);
  const toneOscRef = useRef<OscillatorNode | null>(null);
  const toneGainRef = useRef<GainNode | null>(null);
  const toneTimerRef = useRef<number | null>(null);
  const selectRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const typingTimerRef = useRef<number | null>(null);
  const peerTypingTimerRef = useRef<number | null>(null);
  const peerRef = useRef<User | null>(null);
  const callRef = useRef<CallState>({ status: "idle" });
  const screenShareRef = useRef<{ stream: MediaStream; originalTrack: MediaStreamTrack | null; sender: RTCRtpSender | null } | null>(null);

  useEffect(() => { peerRef.current = peer; }, [peer]);
  useEffect(() => { callRef.current = call; }, [call]);
  useEffect(() => { localStorage.setItem("mas.lang", language); }, [language]);
  useEffect(() => { localStorage.setItem("mas.notifications", String(notificationsEnabled)); }, [notificationsEnabled]);
  useEffect(() => { localStorage.setItem("mas.readReceipts", String(readReceipts)); }, [readReceipts]);
  useEffect(() => { localStorage.setItem("mas.typingIndicator", String(typingIndicator)); }, [typingIndicator]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 50);
  }, []);

  const chatItems = useMemo(() => {
    const labelForType = (type: UiMessage["contentType"]) => {
      switch (type) {
        case "file": return t("file");
        case "gif": return "GIF";
        case "sticker": return t("sticker");
        case "emoji": return t("emoji");
        default: return t("encryptedMessage");
      }
    };
    const items = chatList.map((item) => ({
      id: item.peerId,
      name: item.peerLogin ?? item.peerPhone,
      phone: item.peerPhone,
      lastMessage: labelForType(item.lastContentType),
      time: new Date(item.lastMessageAt).toLocaleTimeString([], {
        hour: "2-digit", minute: "2-digit"
      }),
      online: onlineUserIds.has(item.peerId),
      peerPublicKey: item.peerPublicKey,
      unread: unreadMap[item.peerId] ?? 0
    }));
    if (!chatQuery.trim()) return items;
    const q = chatQuery.toLowerCase().trim();
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.phone.toLowerCase().includes(q) ||
        item.lastMessage.toLowerCase().includes(q)
    );
  }, [chatList, chatQuery, onlineUserIds, unreadMap, t]);

  const countryOptions = useMemo(() => {
    const makeDisplay = (locale: string) => {
      try { return new Intl.DisplayNames([locale], { type: "region" }); } catch { return null; }
    };
    const displayDefault = makeDisplay(language);
    const displayRu = makeDisplay("ru");
    const displayUk = makeDisplay("uk");
    const displayEn = makeDisplay("en");
    return getCountries()
      .map((item) => {
        const names = [
          displayDefault?.of(item), displayRu?.of(item), displayUk?.of(item), displayEn?.of(item)
        ].filter(Boolean) as string[];
        const name = names[0] ?? item;
        return {
          code: item, name, dial: getCountryCallingCode(item),
          search: `${names.join(" ")} ${item}`.toLowerCase()
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, language));
  }, [language]);

  const translitToLatin = (value: string) => {
    const map: Record<string, string> = {
      а:"a",б:"b",в:"v",г:"g",ґ:"g",д:"d",е:"e",ё:"yo",є:"ye",ж:"zh",з:"z",и:"i",і:"i",ї:"yi",
      й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"kh",ц:"ts",
      ч:"ch",ш:"sh",щ:"shch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya"
    };
    return value.split("").map((c) => map[c] ?? c).join("");
  };

  const filteredCountries = useMemo(() => {
    if (!countryQuery.trim()) return countryOptions;
    const normalize = (v: string) => v.toLowerCase().replace(/[().\-\s]/g, "").trim();
    const q = normalize(countryQuery);
    const qLatin = normalize(translitToLatin(q));
    const qDigits = q.replace(/\D/g, "");
    return countryOptions.filter((item) => {
      const name = normalize(item.name);
      const nameLatin = normalize(translitToLatin(name));
      const search = normalize(item.search);
      const searchLatin = normalize(translitToLatin(search));
      const cd = normalize(item.code);
      const dial = normalize(item.dial);
      return (
        name.includes(q) || nameLatin.includes(q) || name.includes(qLatin) ||
        nameLatin.includes(qLatin) || search.includes(q) || searchLatin.includes(q) ||
        search.includes(qLatin) || searchLatin.includes(qLatin) || cd.includes(q) ||
        (qDigits.length > 0 && dial.includes(qDigits))
      );
    });
  }, [countryOptions, countryQuery]);

  const activeCountry = useMemo(() => countryOptions.find((i) => i.code === country), [countryOptions, country]);
  const dialCode = useMemo(() => getCountryCallingCode(country as any), [country]);
  const fullPhone = useMemo(() => `+${dialCode}${localNumber.replace(/\D/g, "")}`, [dialCode, localNumber]);

  const isAuthed = Boolean(token);
  const authHeaders = useMemo(
    (): Record<string, string> => token ? { Authorization: `Bearer ${token}` } : {},
    [token]
  );

  const fetchChats = useCallback(async () => {
    if (!token) return;
    try {
      const res = await fetch(`${API_URL}/chats`, { headers: authHeaders });
      if (!res.ok) return;
      const data = (await res.json()) as ChatSummary[];
      setChatList(data);
    } catch { /* offline */ }
  }, [token, authHeaders]);

  const handleLanguageChange = (next: Lang) => {
    setLanguage(next);
    setStatus("");
  };

  const handleNotificationsChange = async (enabled: boolean) => {
    if (!enabled) {
      setNotificationsEnabled(false);
      return;
    }
    if (!("Notification" in window)) {
      setNotificationsEnabled(false);
      setStatus(t("notificationUnsupported"));
      return;
    }
    if (Notification.permission === "denied") {
      setNotificationsEnabled(false);
      setStatus(t("notificationPermissionDenied"));
      return;
    }
    if (Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setNotificationsEnabled(false);
        setStatus(t("notificationPermissionDenied"));
        return;
      }
    }
    setNotificationsEnabled(true);
  };

  const saveLogin = async () => {
    if (!loginValue.trim()) { setStatus(t("loginRequired")); return; }
    try {
      const res = await fetch(`${API_URL}/users/login`, {
        method: "POST", headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ login: loginValue })
      });
      if (res.status === 409) { setStatus(t("loginTaken")); return; }
      if (!res.ok) { setStatus(t("loginSaveFailed")); return; }
      const data = await res.json();
      setUser((prev) => (prev ? { ...prev, login: data.login } : prev));
      setStatus(t("loginUpdated"));
    } catch { setStatus(t("networkError")); }
  };

  const findUserByLogin = useCallback(async () => {
    if (!chatQuery.trim() || chatQuery.trim().length < 3) { setLoginMatches([]); return; }
    try {
      const res = await fetch(
        `${API_URL}/users/search?query=${encodeURIComponent(chatQuery.trim())}`,
        { headers: authHeaders }
      );
      if (!res.ok) { setLoginMatches([]); return; }
      const data = (await res.json()) as User[];
      setLoginMatches(data);
    } catch { setLoginMatches([]); }
  }, [chatQuery, authHeaders]);

  useEffect(() => {
    if (!token) return;
    fetch(`${API_URL}/users/me`, { headers: authHeaders })
      .then((res) => {
        if (res.status === 401) {
          localStorage.removeItem("mas.token");
          setToken(null);
          return null;
        }
        return res.json();
      })
      .then((data) => {
        if (!data) return;
        setUser(data);
        if (data?.login) setLoginValue(data.login);
      })
      .catch(() => {});
  }, [token, authHeaders]);

  useEffect(() => { fetchChats(); }, [fetchChats]);

  useEffect(() => {
    if (!token) return;
    if (keys) {
      fetch(`${API_URL}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ publicKey: keys.publicKey })
      }).catch(() => {});
      return;
    }
    (async () => {
      try {
        const backupRes = await fetch(`${API_URL}/keys/backup`, { headers: authHeaders });
        if (backupRes.ok) {
          setBackupAvailable(true);
          setStatus(t("backupFound"));
          return;
        }
      } catch { /* ignore */ }
      const pair = generateKeyPair();
      localStorage.setItem("mas.keys", JSON.stringify(pair));
      setKeys(pair);
    })();
  }, [token, keys, authHeaders, t]);

  const saveKeyBackup = async () => {
    if (!keys) { setStatus(t("keysNotReady")); return; }
    if (backupPin.length < 8) { setStatus(t("pinTooShort")); return; }
    try {
      const backup = await createKeyBackupPayload(keys, backupPin);
      const res = await fetch(`${API_URL}/keys/backup`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ publicKey: keys.publicKey, backup })
      });
      if (!res.ok) { setStatus(t("backupSaveFailed")); return; }
      setBackupAvailable(true);
      setBackupPin("");
      setStatus(t("backupSaved"));
    } catch {
      setStatus(t("backupEncryptFailed"));
    }
  };

  const restoreKeyBackup = async () => {
    if (restorePin.length < 8) { setStatus(t("backupPinRequired")); return; }
    try {
      const res = await fetch(`${API_URL}/keys/backup`, { headers: authHeaders });
      if (!res.ok) { setStatus(t("backupMissing")); return; }
      const data = (await res.json()) as KeyBackupResponse;
      const restored = await restoreKeysFromBackup(data.publicKey, data.backup, restorePin);
      localStorage.setItem("mas.keys", JSON.stringify(restored));
      setKeys(restored);
      setRestorePin("");
      setBackupAvailable(true);
      setStatus(t("keyRestored"));
    } catch {
      setStatus(t("keyRestoreFailed"));
    }
  };

  // WebSocket with auto-reconnect
  const connectWebSocket = useCallback(() => {
    if (!token || !shouldReconnectRef.current) return;
    if (wsRef.current) {
      const s = wsRef.current.readyState;
      if (s === WebSocket.OPEN || s === WebSocket.CONNECTING) return;
    }

    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("");
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    };

    ws.onmessage = async (event) => {
      let data: { type?: string; payload?: any };
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      const { type, payload } = data;
      if (!type || !payload) return;
      if (type === "message.receive") {
        const incoming = await handleIncomingMessage(payload);
        fetchChats();
        if (notificationsEnabled) {
          notifSound();
          showBrowserNotification(incoming);
        }
      }
      if (type === "message.delivered") {
        setMessages((prev) =>
          prev.map((msg) =>
            msg.id === payload.id
              ? { ...msg, status: msg.status === "read" ? "read" : "delivered" }
              : msg
          )
        );
      }
      if (type === "message.read") {
        const ids = payload.ids as string[];
        setMessages((prev) =>
          prev.map((msg) => ids.includes(msg.id) ? { ...msg, status: "read" } : msg)
        );
      }
      if (type === "message.deleted") {
        setMessages((prev) => prev.filter((msg) => msg.id !== payload.id));
      }
      if (type === "conversation.deleted") {
        if (payload.peerId === peerRef.current?.id) setMessages([]);
        fetchChats();
      }
      if (type === "message.edited") {
        decryptIncoming(payload).then((decrypted) => {
          setMessages((prev) => prev.map((msg) =>
            msg.id === payload.id ? { ...decrypted, editedAt: payload.editedAt } : msg
          ));
        });
      }
      if (type === "message.pinned") {
        setMessages((prev) => prev.map((msg) =>
          msg.id === payload.id ? { ...msg, pinned: payload.pinned } : msg
        ));
      }
      if (type === "message.reacted") {
        setMessages((prev) => prev.map((msg) =>
          msg.id === payload.id ? { ...msg, reactions: payload.reactions } : msg
        ));
      }
      if (type === "presence") {
        setOnlineUserIds((prev) => {
          const next = new Set(prev);
          if (payload.isOnline) next.add(payload.userId);
          else next.delete(payload.userId);
          return next;
        });
      }
      if (type === "typing") {
        if (payload.from === peerRef.current?.id) {
          setPeerTyping(true);
          if (peerTypingTimerRef.current) clearTimeout(peerTypingTimerRef.current);
          peerTypingTimerRef.current = window.setTimeout(() => setPeerTyping(false), 3000);
        }
      }
      if (type === "call.offer") {
        if (payload.renegotiate && callRef.current.pc && callRef.current.status === "in-call") {
          const pc = callRef.current.pc;
          await pc.setRemoteDescription(payload.offer);
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: "call.answer", payload: { to: payload.from, answer }
            }));
          }
        } else {
          setCall((prev) => ({
            ...prev, status: "incoming", offer: payload.offer,
            isVideo: payload.isVideo, callerId: payload.from
          }));
          if (!peerRef.current || peerRef.current.id !== payload.from) {
            fetchPeerById(payload.from).then((u) => { if (u) setPeer(u); });
          }
        }
      }
      if (type === "call.answer") {
        if (callRef.current.pc && payload.answer) {
          await callRef.current.pc.setRemoteDescription(payload.answer);
          setCall((prev) => ({ ...prev, status: "in-call" }));
        }
      }
      if (type === "call.ice") {
        if (callRef.current.pc && payload.candidate) {
          await callRef.current.pc.addIceCandidate(payload.candidate);
        }
      }
      if (type === "call.end") { endCall(); }
    };

    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      if (shouldReconnectRef.current) {
        reconnectTimer.current = window.setTimeout(() => connectWebSocket(), 2000);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [token, fetchChats, notificationsEnabled, t]);

  useEffect(() => {
    if (!token) return;
    shouldReconnectRef.current = true;
    connectWebSocket();
    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, [token, connectWebSocket]);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (selectRef.current && !selectRef.current.contains(event.target as Node))
        setCountryOpen(false);
    };
    if (countryOpen) document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [countryOpen]);

  useEffect(() => {
    const timer = window.setTimeout(() => findUserByLogin(), 300);
    return () => window.clearTimeout(timer);
  }, [findUserByLogin]);

  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(""), 10000);
    return () => window.clearTimeout(timer);
  }, [status]);

  useEffect(() => { scrollToBottom(); }, [messages, scrollToBottom]);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [ctxMenu]);

  const filteredMessages = useMemo(() => {
    if (!chatSearch.trim()) return messages;
    const q = chatSearch.toLowerCase();
    return messages.filter((m) => m.text?.toLowerCase().includes(q));
  }, [messages, chatSearch]);

  const requestCode = async () => {
    if (!isValidPhoneNumber(fullPhone)) { setStatus(t("invalidPhone")); return false; }
    try {
      const res = await fetch(`${API_URL}/auth/request`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: fullPhone })
      });
      if (!res.ok) { setStatus(t("networkError")); return false; }
      const data = await res.json();
      setDevCode(data.devCode ?? "");
      setStatus(data.devCode ? t("codeSentDev") : t("codeSent"));
      setAuthStep("code");
      return true;
    } catch { setStatus(t("networkError")); return false; }
  };

  const verifyCode = async () => {
    if (!isValidPhoneNumber(fullPhone)) { setStatus(t("invalidPhone")); return; }
    try {
      const res = await fetch(`${API_URL}/auth/verify`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: fullPhone, code })
      });
      const data = await res.json();
      if (data.token) {
        setToken(data.token); localStorage.setItem("mas.token", data.token);
        setUser(data.user); setStatus(t("authSuccess"));
      } else { setStatus(t("wrongCode")); }
    } catch { setStatus(t("networkError")); }
  };

  const startQrLogin = useCallback(async () => {
    try {
      setStatus(ta("qrWaiting"));
      setQrSession(null);
      setQrDataUrl("");
      const res = await fetch(`${API_URL}/auth/qr/start`, { method: "POST" });
      if (!res.ok) { setStatus(ta("qrStartFailed")); return; }
      const data = await res.json() as { qrSessionId?: string; qrPayload?: string; expiresAt?: string };
      if (!data.qrSessionId || !data.qrPayload || !data.expiresAt) {
        setStatus(ta("qrStartFailed"));
        return;
      }
      const url = new URL(data.qrPayload);
      const secret = url.searchParams.get("secret");
      if (!secret) {
        setStatus(ta("qrStartFailed"));
        return;
      }
      const dataUrl = await QRCode.toDataURL(data.qrPayload, {
        width: 224,
        margin: 1,
        color: { dark: "#0c0f1a", light: "#ffffff" }
      });
      setQrSession({ id: data.qrSessionId, secret, payload: data.qrPayload, expiresAt: data.expiresAt });
      setQrDataUrl(dataUrl);
    } catch {
      setStatus(ta("qrStartFailed"));
    }
  }, [ta]);

  useEffect(() => {
    if (authStep === "qr" && !qrSession && !qrDataUrl) {
      startQrLogin();
    }
  }, [authStep, qrDataUrl, qrSession, startQrLogin]);

  useEffect(() => {
    if (authStep !== "qr" || !qrSession) return;
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      if (Date.now() >= Date.parse(qrSession.expiresAt)) {
        setStatus(ta("qrExpired"));
        return;
      }
      try {
        const res = await fetch(
          `${API_URL}/auth/qr/status/${encodeURIComponent(qrSession.id)}?secret=${encodeURIComponent(qrSession.secret)}`
        );
        if (!res.ok) {
          if (res.status === 404 || res.status === 409) setStatus(ta("qrInvalid"));
          return;
        }
        const data = await res.json() as { status?: string; token?: string; user?: User };
        if (data.status === "claimed" && data.token && data.user) {
          stopped = true;
          setStatus(ta("qrApproved"));
          setToken(data.token);
          localStorage.setItem("mas.token", data.token);
          setUser(data.user);
          return;
        }
        if (data.status === "expired") setStatus(ta("qrExpired"));
        else if (data.status === "denied" || data.status === "claimed") setStatus(ta("qrInvalid"));
        else setStatus(ta("qrWaiting"));
      } catch {
        setStatus(t("networkError"));
      }
    };
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [authStep, qrSession, t, ta]);

  const logout = () => {
    setToken(null); setUser(null); setPeer(null); setMessages([]);
    localStorage.removeItem("mas.token");
    shouldReconnectRef.current = false;
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null; }
    const ws = wsRef.current;
    wsRef.current = null;
    ws?.close();
  };

  const findPeer = async (phone: string) => {
    try {
      const res = await fetch(`${API_URL}/users/by-phone?phone=${encodeURIComponent(phone)}`, { headers: authHeaders });
      if (!res.ok) { setStatus(t("userNotFound")); return; }
      const data = (await res.json()) as User;
      setPeer(data); setStatus(t("contactAdded"));
      await loadMessages(data.id);
    } catch { setStatus(t("networkError")); }
  };

  const loadMessages = async (peerId: string, append = false) => {
    if (!token || !keys) return;
    try {
      const offset = append ? messages.length : 0;
      const res = await fetch(`${API_URL}/messages/${peerId}?limit=100&offset=${offset}`, { headers: authHeaders });
      const data = await res.json();
      const mapped: UiMessage[] = [];
      for (const item of data) { mapped.push(await decryptIncoming(item)); }
      if (append) { setMessages((prev) => [...mapped, ...prev]); }
      else { setMessages(mapped); }
      const incomingIds = mapped.filter((msg) => !msg.isMine).map((msg) => msg.id);
      sendReadReceipts(peerId, incomingIds);
      setUnreadMap((prev) => ({ ...prev, [peerId]: 0 }));
    } catch { /* offline */ }
  };

  const fetchPeerById = async (peerId: string) => {
    try {
      const res = await fetch(`${API_URL}/users/${peerId}`, { headers: authHeaders });
      if (!res.ok) return null;
      return (await res.json()) as User;
    } catch { return null; }
  };

  const handleSelectChat = async (chat: {
    id: string; name: string; phone: string; peerPublicKey?: string;
  }) => {
    setActiveTab("chat"); setMessages([]);
    const peerInfo = await fetchPeerById(chat.id);
    setPeer(peerInfo ?? {
      id: chat.id, phone: chat.phone,
      login: chat.name !== chat.phone ? chat.name : undefined,
      publicKey: chat.peerPublicKey
    });
    await loadMessages(chat.id);
  };

  const handleSelectUser = async (userToOpen: User) => {
    setActiveTab("chat"); setMessages([]);
    setPeer(userToOpen); setChatQuery(""); setLoginMatches([]);
    await loadMessages(userToOpen.id);
  };

  const tryDecrypt = (nonce: string, ct: string, pubKey: string, secKey: string): string | undefined => {
    try { return decryptMessage(nonce, ct, pubKey, secKey) ?? undefined; } catch { return undefined; }
  };

  const decryptIncoming = async (payload: any): Promise<UiMessage> => {
    const isMine = payload.from === user?.id;
    if (!keys) {
      return {
        id: payload.id, from: payload.from, to: payload.to,
        createdAt: payload.createdAt, contentType: payload.contentType,
        text: `🔒 ${t("noKeysEncrypted")}`, meta: { ...payload.meta, decryptFailed: "true" },
        isMine
      };
    }
    let text: string | undefined;
    let decryptFailed = false;

    // Try self-encrypted copy first (works for own messages regardless of peer key changes)
    if (payload.selfCiphertext && payload.selfNonce) {
      text = tryDecrypt(payload.selfNonce, payload.selfCiphertext, keys.publicKey, keys.secretKey);
    }

    // Try peer-encrypted copy with senderPublicKey
    if (!text && payload.ciphertext && payload.nonce && payload.senderPublicKey) {
      text = tryDecrypt(payload.nonce, payload.ciphertext, payload.senderPublicKey, keys.secretKey);
    }

    // Try peer-encrypted copy with peer's current publicKey
    if (!text && payload.ciphertext && payload.nonce && peer?.publicKey) {
      text = tryDecrypt(payload.nonce, payload.ciphertext, peer.publicKey, keys.secretKey);
    }

    // Try peer-encrypted copy with own publicKey (in case the message was to ourselves)
    if (!text && payload.ciphertext && payload.nonce) {
      text = tryDecrypt(payload.nonce, payload.ciphertext, keys.publicKey, keys.secretKey);
    }

    if (!text && payload.contentType === "text") {
      text = `🔒 ${t("wrongKeyEncrypted")}`;
      decryptFailed = true;
    }

    const msgStatus = isMine
      ? payload.readAt ? "read" : payload.deliveredAt ? "delivered" : "sent"
      : undefined;
    return {
      id: payload.id, from: payload.from, to: payload.to,
      createdAt: payload.createdAt, contentType: payload.contentType,
      text, meta: payload.meta
        ? { ...payload.meta, senderPublicKey: payload.senderPublicKey, ...(decryptFailed ? { decryptFailed: "true" } : {}) }
        : { senderPublicKey: payload.senderPublicKey, ...(decryptFailed ? { decryptFailed: "true" } : {}) },
      isMine, status: msgStatus as UiMessage["status"],
      replyToId: payload.replyToId,
      editedAt: payload.editedAt,
      pinned: payload.pinned,
      reactions: payload.reactions
    };
  };

  const sendReadReceipts = (peerId: string, ids: string[]) => {
    if (!readReceipts) return;
    if (!ids.length || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "message.read", payload: { peerId, ids } }));
  };

  const showBrowserNotification = (msg: UiMessage) => {
    if (document.visibilityState !== "hidden") return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    const from = peerRef.current?.id === msg.from
      ? peerRef.current.login ?? peerRef.current.phone
      : t("notificationTitle");
    const body = msg.text || (msg.contentType === "file" ? t("file") : t("encryptedMessage"));
    try {
      new Notification(from, { body, tag: msg.id });
    } catch { /* ignore */ }
  };

  const handleIncomingMessage = async (payload: any) => {
    const decrypted = await decryptIncoming(payload);
    setMessages((prev) => [...prev, decrypted]);
    if (peer && payload.from === peer.id && activeTab === "chat") {
      sendReadReceipts(peer.id, [payload.id]);
    } else {
      setUnreadMap((prev) => ({
        ...prev,
        [payload.from]: (prev[payload.from] ?? 0) + 1
      }));
    }
    return decrypted;
  };

  const sendTyping = () => {
    if (!typingIndicator) return;
    if (!peer || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    if (typingTimerRef.current) return;
    wsRef.current.send(JSON.stringify({ type: "typing", payload: { to: peer.id } }));
    typingTimerRef.current = window.setTimeout(() => { typingTimerRef.current = null; }, 2000);
  };

  const sendMessage = async (
    contentType: UiMessage["contentType"],
    text?: string,
    meta?: Record<string, string>,
    replyToId?: string
  ) => {
    if (!peer) { setStatus(t("chooseChat")); return; }
    if (!keys) { setStatus(t("keysNotReady")); return; }
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatus(t("noConnection")); return;
    }
    let targetKey = peer.publicKey;
    if (!targetKey) {
      const refreshed = await fetchPeerById(peer.id);
      if (refreshed?.publicKey) { setPeer(refreshed); targetKey = refreshed.publicKey; }
      else { setStatus(t("peerNoPublicKey")); return; }
    }
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const payloadText = text ?? "";
    const encrypted = encryptMessage(payloadText, keys.secretKey, targetKey);
    const selfEncrypted = encryptMessage(payloadText, keys.secretKey, keys.publicKey);
    wsRef.current.send(JSON.stringify({
      type: "message.send",
      payload: {
        id, to: peer.id, createdAt, contentType,
        nonce: encrypted.nonce, ciphertext: encrypted.ciphertext,
        senderPublicKey: keys.publicKey,
        selfNonce: selfEncrypted.nonce, selfCiphertext: selfEncrypted.ciphertext,
        meta,
        ...(replyToId ? { replyToId } : {})
      }
    }));
    setMessages((prev) => [
      ...prev,
      { id, from: user?.id ?? "", to: peer.id, createdAt, contentType, text, meta, isMine: true, status: "sent", replyToId }
    ]);
    fetchChats();
  };

  const handleSendText = () => {
    const value = msgInput.trim();
    if (!value) return;
    if (editingMsg) {
      editMessage(editingMsg.id, value);
      setMsgInput("");
      return;
    }
    sendMessage("text", value, undefined, replyTo?.id);
    setMsgInput("");
    setShowEmoji(false);
    setReplyTo(null);
  };

  const editMessage = async (msgId: string, newText: string) => {
    if (!peer || !keys || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    let targetKey = peer.publicKey;
    if (!targetKey) return;
    const encrypted = encryptMessage(newText, keys.secretKey, targetKey);
    const selfEncrypted = encryptMessage(newText, keys.secretKey, keys.publicKey);
    wsRef.current.send(JSON.stringify({
      type: "message.edit",
      payload: {
        id: msgId, peerId: peer.id,
        nonce: encrypted.nonce, ciphertext: encrypted.ciphertext,
        selfNonce: selfEncrypted.nonce, selfCiphertext: selfEncrypted.ciphertext,
        senderPublicKey: keys.publicKey
      }
    }));
    setMessages((prev) => prev.map((m) =>
      m.id === msgId ? { ...m, text: newText, editedAt: new Date().toISOString() } : m
    ));
    setEditingMsg(null);
  };

  const pinMessage = (msgId: string) => {
    if (!peer || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "message.pin", payload: { id: msgId, peerId: peer.id } }));
    setMessages((prev) => prev.map((m) =>
      m.id === msgId ? { ...m, pinned: !m.pinned } : m
    ));
  };

  const reactToMessage = (msgId: string, emoji: string) => {
    if (!peer || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ type: "message.react", payload: { id: msgId, peerId: peer.id, emoji } }));
    setMessages((prev) => prev.map((m) => {
      if (m.id !== msgId) return m;
      const reactions = { ...(m.reactions ?? {}) };
      if (!reactions[emoji]) reactions[emoji] = [];
      const uid = user?.id ?? "";
      const idx = reactions[emoji].indexOf(uid);
      if (idx >= 0) { reactions[emoji].splice(idx, 1); if (!reactions[emoji].length) delete reactions[emoji]; }
      else { reactions[emoji].push(uid); }
      return { ...m, reactions };
    }));
    setReactionPicker(null);
  };

  const copyMessageText = (text: string) => {
    navigator.clipboard.writeText(text).then(() => setStatus(t("copied"))).catch(() => {});
  };

  const startReply = (msg: UiMessage) => { setReplyTo(msg); setEditingMsg(null); setCtxMenu(null); };
  const startEdit = (msg: UiMessage) => { setEditingMsg(msg); setMsgInput(msg.text ?? ""); setReplyTo(null); setCtxMenu(null); };
  const cancelReplyEdit = () => { setReplyTo(null); setEditingMsg(null); setMsgInput(""); };

  const deleteMessage = (msgId: string) => {
    if (!peer || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({
      type: "message.delete",
      payload: { id: msgId, peerId: peer.id }
    }));
    setMessages((prev) => prev.filter((m) => m.id !== msgId));
  };

  const clearChat = async () => {
    if (!peer || !token) return;
    const choice = window.prompt(t("clearPrompt"));
    if (choice !== "me" && choice !== "both") return;
    if (choice === "both" && !confirm(t("clearBothConfirm"))) return;
    try {
      const res = await fetch(`${API_URL}/messages/${peer.id}?scope=${choice}`, {
        method: "DELETE", headers: authHeaders
      });
      if (!res.ok) { setStatus(t("clearFailed")); return; }
      setMessages([]);
      fetchChats();
      setStatus(t("chatCleared"));
    } catch { setStatus(t("clearFailed")); }
  };

  const handleFile = async (file: File | null) => {
    if (!file || !peer || !keys) return;
    if (!peer.publicKey) { setStatus(t("peerNoPublicKey")); return; }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const encrypted = encryptBytes(bytes, keys.secretKey, peer.publicKey);
      const blob = new Blob([fromBase64(encrypted.ciphertext) as any], { type: "application/octet-stream" });
      const form = new FormData();
      form.append("file", blob, `${file.name}.enc`);
      form.append("peerId", peer.id);
      const res = await fetch(`${API_URL}/files`, {
        method: "POST", headers: authHeaders, body: form
      });
      if (!res.ok) { setStatus(t("uploadFailed")); return; }
      const data = await res.json();
      await sendMessage("file", "", {
        fileName: file.name, fileType: file.type,
        fileId: data.fileId,
        nonce: encrypted.nonce
      });
    } catch { setStatus(t("uploadFailed")); }
  };

  const decryptFile = async (msg: UiMessage) => {
    if (!msg.meta || !keys || !peer) return;
    try {
      const fileUrl = msg.meta.fileId ? `${API_URL}/files/${msg.meta.fileId}` : msg.meta.fileUrl;
      if (!fileUrl) { setStatus(t("fileUnavailable")); return; }
      const response = await fetch(fileUrl, { headers: authHeaders });
      if (!response.ok) { setStatus(t("fileUnavailable")); return; }
      const buffer = new Uint8Array(await response.arrayBuffer());
      const decrypted = decryptBytes(
        msg.meta.nonce, toBase64(buffer),
        msg.meta.senderPublicKey ?? peer.publicKey ?? "", keys.secretKey
      );
      if (!decrypted) { setStatus(t("fileDecryptFailed")); return; }
      const blobOut = new Blob([decrypted as any], { type: msg.meta.fileType || "application/octet-stream" });
      const url = URL.createObjectURL(blobOut);
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch { setStatus(t("uploadFailed")); }
  };

  

  // -- Call window --
  const renderCallWindow = () => {
    const win = window.open("", "mas-call", "width=480,height=720");
    if (!win) return null;
    win.document.title = t("callWindowTitle");
    const peerDisplay = peer?.login ?? peer?.phone ?? t("subscriber");
    const peerInitial = peerDisplay.slice(0, 1).toUpperCase();
    const callLabel = t("call");
    const connectingLabel = t("connecting");
    const micLabel = t("microphone");
    const cameraLabel = t("camera");
    const endLabel = t("end");
    const screenShareLabel = t("screenShare");
    const fullscreenLabel = t("fullscreen");
    const screenLabel = t("screen");
    const screenSharingLabel = t("screenSharing");
    win.document.head.innerHTML = `
      <meta charset="UTF-8">`;
    win.document.body.innerHTML = `
      <style>
        *{box-sizing:border-box;margin:0;padding:0}
        body{background:#0c0f1a;color:#f4f6fb;font-family:'Inter',system-ui,sans-serif;overflow:hidden;user-select:none}
        .wrap{display:flex;flex-direction:column;height:100vh;position:relative}
        .bg{position:absolute;inset:0;z-index:0;overflow:hidden}
        .bg::before{content:'';position:absolute;width:600px;height:600px;top:-200px;left:-100px;border-radius:50%;background:radial-gradient(circle,rgba(59,130,246,0.15),transparent 70%);animation:drift 12s ease-in-out infinite alternate}
        .bg::after{content:'';position:absolute;width:500px;height:500px;bottom:-150px;right:-100px;border-radius:50%;background:radial-gradient(circle,rgba(34,211,238,0.1),transparent 70%);animation:drift 10s ease-in-out infinite alternate-reverse}
        @keyframes drift{0%{transform:translate(0,0)}100%{transform:translate(40px,30px)}}
        .top{position:relative;z-index:1;padding:24px 20px 16px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px}
        .top .type{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.12em;color:rgba(244,246,251,0.5)}
        .peer-name{font-size:20px;font-weight:700;letter-spacing:0.02em}
        .call-status{font-size:13px;color:rgba(244,246,251,0.6);display:flex;align-items:center;gap:6px}
        .call-status .dot{width:6px;height:6px;border-radius:50%;background:#4ade80;animation:blink 1.5s ease infinite}
        @keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
        .timer{font-size:22px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:0.04em;color:rgba(244,246,251,0.85);margin-top:2px}
        .center{flex:1;position:relative;z-index:1;display:flex;align-items:center;justify-content:center}
        .avatar-wrap{display:flex;flex-direction:column;align-items:center;gap:20px}
        .avatar{width:120px;height:120px;border-radius:50%;background:linear-gradient(135deg,rgba(59,130,246,0.35),rgba(34,211,238,0.25));display:flex;align-items:center;justify-content:center;font-size:48px;font-weight:700;position:relative}
        .avatar::before{content:'';position:absolute;inset:-8px;border-radius:50%;border:2px solid rgba(59,130,246,0.25);animation:ring 2.5s ease-in-out infinite}
        .avatar::after{content:'';position:absolute;inset:-16px;border-radius:50%;border:1px solid rgba(34,211,238,0.12);animation:ring 3s ease-in-out infinite 0.5s}
        @keyframes ring{0%,100%{transform:scale(1);opacity:0.6}50%{transform:scale(1.06);opacity:0.2}}
        .wave-wrap{display:flex;gap:3px;align-items:flex-end;height:28px}
        .wave-bar{width:4px;border-radius:2px;background:linear-gradient(to top,#3b82f6,#22d3ee);animation:wave 1.2s ease-in-out infinite}
        .wave-bar:nth-child(1){height:12px;animation-delay:0s}
        .wave-bar:nth-child(2){height:20px;animation-delay:0.15s}
        .wave-bar:nth-child(3){height:16px;animation-delay:0.3s}
        .wave-bar:nth-child(4){height:24px;animation-delay:0.45s}
        .wave-bar:nth-child(5){height:14px;animation-delay:0.6s}
        @keyframes wave{0%,100%{transform:scaleY(0.4)}50%{transform:scaleY(1)}}
        #remoteVideo{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;z-index:0;display:none;background:#111623}
        #localVideo{position:absolute;right:16px;bottom:16px;width:160px;height:200px;object-fit:cover;border-radius:16px;border:2px solid rgba(255,255,255,0.12);z-index:3;display:none;box-shadow:0 8px 24px rgba(0,0,0,0.4);cursor:grab;transition:box-shadow 0.2s}
        #localVideo:hover{box-shadow:0 12px 32px rgba(0,0,0,0.6)}
        .bar{position:relative;z-index:2;padding:16px 24px 28px;display:flex;justify-content:center;gap:16px;background:linear-gradient(to top,rgba(12,15,26,0.85),transparent);backdrop-filter:blur(8px)}
        .btn{width:56px;height:56px;border-radius:50%;border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform 0.15s,background 0.2s,box-shadow 0.2s;position:relative}
        .btn:hover{transform:scale(1.08)}
        .btn:active{transform:scale(0.95)}
        .btn svg{width:22px;height:22px;fill:none;stroke:#f4f6fb;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
        .btn-default{background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.12)}
        .btn-default:hover{background:rgba(255,255,255,0.16);border-color:rgba(255,255,255,0.2)}
        .btn-active{background:rgba(245,158,11,0.25);border:1px solid rgba(245,158,11,0.4)}
        .btn-active svg{stroke:#f59e0b}
        .btn-active:hover{background:rgba(245,158,11,0.35)}
        .btn-end{background:#ef4444;border:1px solid rgba(239,68,68,0.6);box-shadow:0 4px 20px rgba(239,68,68,0.3)}
        .btn-end:hover{background:#dc2626;box-shadow:0 6px 28px rgba(239,68,68,0.4)}
        .btn-end svg{stroke:#fff}
        .btn-label{position:absolute;bottom:-20px;left:50%;transform:translateX(-50%);font-size:10px;color:rgba(244,246,251,0.5);white-space:nowrap;letter-spacing:0.04em;font-weight:500}
        .screen-indicator{display:flex;align-items:center;gap:6px;padding:4px 12px;border-radius:20px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.3);color:#fca5a5;font-size:11px;font-weight:600;letter-spacing:0.04em;margin-top:4px;animation:screenPulse 2s ease infinite}
        @keyframes screenPulse{0%,100%{opacity:1}50%{opacity:0.6}}
        .video-overlay .top{background:linear-gradient(to bottom,rgba(12,15,26,0.7),transparent);position:absolute;top:0;left:0;right:0;z-index:2}
        .video-overlay .bar{position:absolute;bottom:0;left:0;right:0;z-index:2}
        .video-overlay .center{display:none}
      </style>
      <div class="wrap" id="callWrap">
        <div class="bg"></div>
        <div class="top">
          <div class="type" id="callLabel">${callLabel}</div>
          <div class="peer-name" id="peerName"></div>
          <div class="call-status" id="statusLabel"><span class="dot"></span><span id="statusText">${connectingLabel}</span></div>
          <div class="timer" id="timerLabel">00:00</div>
          <div class="screen-indicator" id="screenIndicator" style="display:none">
            <svg viewBox="0 0 24 24" width="14" height="14"><rect x="2" y="3" width="20" height="14" rx="2" ry="2" fill="none" stroke="currentColor" stroke-width="2"/><line x1="8" y1="21" x2="16" y2="21" stroke="currentColor" stroke-width="2"/><line x1="12" y1="17" x2="12" y2="21" stroke="currentColor" stroke-width="2"/></svg>
            <span>${screenSharingLabel}</span>
          </div>
        </div>
        <div class="center" id="centerArea">
          <div class="avatar-wrap">
            <div class="avatar" id="avatarEl"></div>
            <div class="wave-wrap" id="waveWrap">
              <div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div><div class="wave-bar"></div>
            </div>
          </div>
        </div>
        <video id="remoteVideo" autoplay playsinline></video>
        <video id="localVideo" autoplay playsinline muted></video>
        <div class="bar">
          <button class="btn btn-default" id="micBtn" title="${micLabel}">
            <svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            <span class="btn-label">${micLabel}</span>
          </button>
          <button class="btn btn-default" id="camBtn" title="${cameraLabel}">
            <svg viewBox="0 0 24 24"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
            <span class="btn-label">${cameraLabel}</span>
          </button>
          <button class="btn btn-end" id="endCallBtn" title="${endLabel}">
            <svg viewBox="0 0 24 24"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.15-1.15a1 1 0 0 1 .9-.27 11.4 11.4 0 0 0 3.87.65 1 1 0 0 1 .99 1v3.5a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.22 2.6.65 3.87a1 1 0 0 1-.27.9z" stroke="#fff" fill="none"/><line x1="1" y1="1" x2="23" y2="23" stroke="#fff"/></svg>
            <span class="btn-label">${endLabel}</span>
          </button>
          <button class="btn btn-default" id="screenBtn" title="${screenShareLabel}">
            <svg viewBox="0 0 24 24"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span class="btn-label">${screenLabel}</span>
          </button>
          <button class="btn btn-default" id="fullscreenBtn" title="${fullscreenLabel}">
            <svg viewBox="0 0 24 24"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>
            <span class="btn-label">${screenLabel}</span>
          </button>
        </div>
      </div>`;

    const peerNameEl = win.document.getElementById("peerName");
    const avatarEl = win.document.getElementById("avatarEl");
    if (peerNameEl) peerNameEl.textContent = peerDisplay;
    if (avatarEl) avatarEl.textContent = peerInitial;

    const $ = (id: string) => win.document.getElementById(id);
    const endButton = $("endCallBtn");
    if (endButton) endButton.addEventListener("click", () => endCall());

    const micBtn = $("micBtn") as HTMLButtonElement | null;
    if (micBtn) micBtn.addEventListener("click", () => toggleMic());

    const camBtn = $("camBtn") as HTMLButtonElement | null;
    if (camBtn) camBtn.addEventListener("click", () => toggleCamera());

    const fullscreenBtn = $("fullscreenBtn") as HTMLButtonElement | null;
    if (fullscreenBtn) fullscreenBtn.addEventListener("click", () => {
      if (!win.document.fullscreenElement) win.document.documentElement.requestFullscreen().catch(() => {});
      else win.document.exitFullscreen().catch(() => {});
    });

    const screenBtn = $("screenBtn") as HTMLButtonElement | null;
    if (screenBtn) screenBtn.addEventListener("click", () => shareScreen());

    const localVideo = $("localVideo") as HTMLVideoElement | null;
    if (localVideo) {
      let dragging = false, ox = 0, oy = 0;
      localVideo.addEventListener("mousedown", (e) => {
        dragging = true; ox = e.offsetX; oy = e.offsetY;
        localVideo.style.cursor = "grabbing";
      });
      win.document.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        localVideo.style.right = "auto"; localVideo.style.bottom = "auto";
        localVideo.style.left = `${e.clientX - ox}px`;
        localVideo.style.top = `${e.clientY - oy}px`;
      });
      win.document.addEventListener("mouseup", () => { dragging = false; localVideo.style.cursor = "grab"; });
    }

    const timerLabel = $("timerLabel") as HTMLDivElement | null;
    const timerInterval = win.setInterval(() => {
      const parts = callWindowPartsRef.current;
      if (!parts?.timerStartTime) {
        if (timerLabel) timerLabel.textContent = "00:00";
        return;
      }
      const elapsed = Math.floor((Date.now() - parts.timerStartTime) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, "0");
      const s = String(elapsed % 60).padStart(2, "0");
      if (timerLabel) timerLabel.textContent = `${m}:${s}`;
    }, 1000) as unknown as number;

    callWindowPartsRef.current = {
      localVideo: localVideo ?? undefined,
      remoteVideo: $("remoteVideo") as HTMLVideoElement | undefined,
      label: $("callLabel") as HTMLDivElement | undefined,
      peerName: $("peerName") as HTMLDivElement | undefined,
      statusLabel: $("statusText") as HTMLDivElement | undefined,
      timerLabel: timerLabel ?? undefined,
      avatar: $("avatarEl") as HTMLDivElement | undefined,
      micBtn: micBtn ?? undefined,
      camBtn: camBtn ?? undefined,
      fullscreenBtn: fullscreenBtn ?? undefined,
      timerInterval,
      timerStartTime: undefined,
    };
    return win;
  };

  const toggleMic = () => {
    const stream = callRef.current.localStream;
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const parts = callWindowPartsRef.current;
    if (parts?.micBtn) {
      parts.micBtn.className = track.enabled ? "btn btn-default" : "btn btn-active";
    }
  };

  const toggleCamera = async () => {
    const pc = callRef.current.pc;
    const stream = callRef.current.localStream;
    if (!pc || !stream) return;
    const existingTrack = stream.getVideoTracks()[0];

    if (existingTrack) {
      existingTrack.enabled = !existingTrack.enabled;
      const parts = callWindowPartsRef.current;
      if (parts?.camBtn) parts.camBtn.className = existingTrack.enabled ? "btn btn-default" : "btn btn-active";
      if (parts?.localVideo) parts.localVideo.style.opacity = existingTrack.enabled ? "1" : "0.3";
      return;
    }

    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: true });
      const camTrack = camStream.getVideoTracks()[0];
      stream.addTrack(camTrack);
      pc.addTrack(camTrack, stream);

      if (pc.signalingState !== "closed") {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const targetId = peerRef.current?.id ?? callRef.current.callerId;
        if (targetId && wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: "call.offer",
            payload: { to: targetId, offer: pc.localDescription, isVideo: true, renegotiate: true }
          }));
        }
      }

      setCall((prev) => ({ ...prev, isVideo: true, localStream: stream }));
      const parts = callWindowPartsRef.current;
      if (parts?.camBtn) parts.camBtn.className = "btn btn-default";
      if (parts?.localVideo) {
        parts.localVideo.srcObject = stream;
        parts.localVideo.style.display = "block";
        parts.localVideo.style.opacity = "1";
      }
      switchCallWindowToVideo();
    } catch {
      setStatus(t("cameraEnableFailed"));
    }
  };

  const switchCallWindowToVideo = () => {
    const win = callWindowRef.current;
    if (!win) return;
    const parts = callWindowPartsRef.current;
    if (parts?.label) parts.label.textContent = t("videoCallUpper");
    if (parts?.remoteVideo) parts.remoteVideo.style.display = "block";
    if (parts?.localVideo) parts.localVideo.style.display = "block";
    const wrap = win.document.getElementById("callWrap");
    const centerArea = win.document.getElementById("centerArea");
    wrap?.classList.add("video-overlay");
    if (centerArea) centerArea.style.display = "none";
  };

  const stopScreenShare = () => {
    const ss = screenShareRef.current;
    if (!ss) return;
    ss.stream.getTracks().forEach((t) => t.stop());
    const pc = callRef.current.pc;
    if (pc && ss.sender) {
      if (ss.originalTrack) {
        ss.sender.replaceTrack(ss.originalTrack);
      } else {
        pc.removeTrack(ss.sender);
        if (pc.signalingState !== "closed") {
          pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => {
            const targetId = peerRef.current?.id ?? callRef.current.callerId;
            if (targetId && wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                type: "call.offer", payload: { to: targetId, offer: pc.localDescription, isVideo: callRef.current.isVideo, renegotiate: true }
              }));
            }
          }).catch(() => {});
        }
      }
    }
    screenShareRef.current = null;
    updateScreenBtnState(false);
    updateCallWindowScreenMode(false);
  };

  const shareScreen = async () => {
    if (screenShareRef.current) { stopScreenShare(); return; }
    const pc = callRef.current.pc;
    if (!pc) return;
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = screenStream.getVideoTracks()[0];
      const existingSender = pc.getSenders().find((s) => s.track?.kind === "video");
      let sender: RTCRtpSender;
      let originalTrack: MediaStreamTrack | null = null;

      if (existingSender) {
        originalTrack = existingSender.track;
        await existingSender.replaceTrack(screenTrack);
        sender = existingSender;
      } else {
        sender = pc.addTrack(screenTrack, screenStream);
        if (pc.signalingState !== "closed") {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          const targetId = peerRef.current?.id ?? callRef.current.callerId;
          if (targetId && wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify({
              type: "call.offer", payload: { to: targetId, offer: pc.localDescription, isVideo: callRef.current.isVideo, renegotiate: true }
            }));
          }
        }
      }

      screenShareRef.current = { stream: screenStream, originalTrack, sender };
      updateScreenBtnState(true);
      updateCallWindowScreenMode(true);

      const parts = callWindowPartsRef.current;
      if (parts?.localVideo) {
        parts.localVideo.srcObject = screenStream;
        parts.localVideo.style.display = "block";
        parts.localVideo.style.opacity = "1";
      }

      screenTrack.onended = () => stopScreenShare();
    } catch { /* user cancelled picker */ }
  };

  const updateScreenBtnState = (active: boolean) => {
    const win = callWindowRef.current;
    if (!win) return;
    const btn = win.document.getElementById("screenBtn");
    if (btn) btn.className = active ? "btn btn-active" : "btn btn-default";
    const indicator = win.document.getElementById("screenIndicator");
    if (indicator) indicator.style.display = active ? "flex" : "none";
  };

  const updateCallWindowScreenMode = (sharing: boolean) => {
    const win = callWindowRef.current;
    if (!win) return;
    const wrap = win.document.getElementById("callWrap");
    const centerArea = win.document.getElementById("centerArea");
    if (sharing && !callRef.current.isVideo) {
      wrap?.classList.add("video-overlay");
      if (centerArea) centerArea.style.display = "none";
      const parts = callWindowPartsRef.current;
      if (parts?.localVideo) {
        parts.localVideo.style.display = "block";
        parts.localVideo.style.width = "100%";
        parts.localVideo.style.height = "100%";
        parts.localVideo.style.position = "absolute";
        parts.localVideo.style.inset = "0";
        parts.localVideo.style.borderRadius = "0";
        parts.localVideo.style.border = "none";
        parts.localVideo.style.zIndex = "0";
        parts.localVideo.style.cursor = "default";
      }
    } else if (!sharing && !callRef.current.isVideo) {
      wrap?.classList.remove("video-overlay");
      if (centerArea) centerArea.style.display = "flex";
      const parts = callWindowPartsRef.current;
      if (parts?.localVideo) {
        parts.localVideo.style.display = "none";
        parts.localVideo.srcObject = callRef.current.localStream ?? null;
        parts.localVideo.style.width = ""; parts.localVideo.style.height = "";
        parts.localVideo.style.position = ""; parts.localVideo.style.inset = "";
        parts.localVideo.style.borderRadius = ""; parts.localVideo.style.border = "";
        parts.localVideo.style.zIndex = ""; parts.localVideo.style.cursor = "";
      }
    } else if (!sharing && callRef.current.isVideo) {
      const parts = callWindowPartsRef.current;
      if (parts?.localVideo) {
        parts.localVideo.srcObject = callRef.current.localStream ?? null;
      }
    }
  };

  const ensureCallWindow = (isVideo: boolean) => {
    if (!callWindowRef.current || callWindowRef.current.closed) callWindowRef.current = renderCallWindow();
    const parts = callWindowPartsRef.current;
    if (!parts) return;
    const win = callWindowRef.current;

    if (parts.label) parts.label.textContent = isVideo ? t("videoCallUpper") : t("audioCallUpper");

    const peerDisplay = peer?.login ?? peer?.phone ?? t("subscriber");
    if (parts.peerName) parts.peerName.textContent = peerDisplay;

    if (parts.remoteVideo) parts.remoteVideo.style.display = isVideo ? "block" : "none";
    if (parts.localVideo) parts.localVideo.style.display = isVideo ? "block" : "none";

    const wrap = win?.document.getElementById("callWrap");
    const centerArea = win?.document.getElementById("centerArea");
    const waveWrap = win?.document.getElementById("waveWrap");
    if (isVideo) {
      wrap?.classList.add("video-overlay");
      if (centerArea) centerArea.style.display = "none";
    } else {
      wrap?.classList.remove("video-overlay");
      if (centerArea) centerArea.style.display = "flex";
      if (waveWrap) waveWrap.style.display = "flex";
    }

    if (call.status === "in-call") {
      if (parts.statusLabel) parts.statusLabel.textContent = t("activeCallStatus");
      if (!parts.timerStartTime) parts.timerStartTime = Date.now();
    }
    if (call.status === "calling" && parts.statusLabel) parts.statusLabel.textContent = t("calling");
  };

  const syncCallWindowStreams = (localStream?: MediaStream, remoteStream?: MediaStream) => {
    const parts = callWindowPartsRef.current;
    if (!parts) return;
    if (parts.localVideo && localStream) parts.localVideo.srcObject = localStream;
    if (parts.remoteVideo && remoteStream) parts.remoteVideo.srcObject = remoteStream;
  };

  const closeCallWindow = () => {
    if (callWindowPartsRef.current?.timerInterval) {
      callWindowRef.current?.clearInterval(callWindowPartsRef.current.timerInterval);
    }
    if (callWindowRef.current && !callWindowRef.current.closed) callWindowRef.current.close();
    callWindowRef.current = null; callWindowPartsRef.current = null;
  };

  const stopTone = () => {
    if (toneTimerRef.current) { window.clearInterval(toneTimerRef.current); toneTimerRef.current = null; }
    if (toneOscRef.current) { toneOscRef.current.stop(); toneOscRef.current.disconnect(); toneOscRef.current = null; }
    if (toneGainRef.current) { toneGainRef.current.disconnect(); toneGainRef.current = null; }
  };

  const startTone = (kind: "incoming" | "outgoing") => {
    stopTone();
    if (!toneCtxRef.current) toneCtxRef.current = new AudioContext();
    const ctx = toneCtxRef.current;
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = kind === "incoming" ? 520 : 440;
    gain.gain.value = 0;
    osc.connect(gain); gain.connect(ctx.destination); osc.start();
    toneOscRef.current = osc; toneGainRef.current = gain;
    let on = false;
    toneTimerRef.current = window.setInterval(() => { on = !on; gain.gain.value = on ? 0.2 : 0; }, kind === "incoming" ? 600 : 900);
  };

  const createPeerConnection = () =>
    new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });

  const startCall = async (isVideo = false) => {
    if (!peer) return;
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatus(t("noConnection")); return;
    }
    try {
      const pc = createPeerConnection();
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          wsRef.current?.send(JSON.stringify({
            type: "call.ice", payload: { to: peer.id, candidate: event.candidate }
          }));
        }
      };
      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
        setCall((prev) => ({ ...prev, remoteStream: stream }));
      };
      const localStream = await navigator.mediaDevices.getUserMedia(
        isVideo ? { audio: true, video: true } : { audio: true }
      );
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsRef.current.send(JSON.stringify({
        type: "call.offer", payload: { to: peer.id, offer, isVideo }
      }));
      setCall({ status: "calling", pc, localStream, isVideo });
    } catch (err) {
      setStatus(t("callStartFailed"));
    }
  };

  const acceptCall = async () => {
    if (!call.offer) return;
    stopTone();
    let currentPeer = peer;
    if (!currentPeer && call.callerId) {
      const fetched = await fetchPeerById(call.callerId);
      if (fetched) { setPeer(fetched); currentPeer = fetched; }
    }
    if (!currentPeer) { setStatus(t("peerMissing")); return; }
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setStatus(t("noConnection")); return;
    }
    try {
      const pc = createPeerConnection();
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          wsRef.current?.send(JSON.stringify({
            type: "call.ice", payload: { to: currentPeer!.id, candidate: event.candidate }
          }));
        }
      };
      pc.ontrack = (event) => {
        const stream = event.streams[0];
        if (remoteAudioRef.current) remoteAudioRef.current.srcObject = stream;
        setCall((prev) => ({ ...prev, remoteStream: stream }));
      };
      const localStream = await navigator.mediaDevices.getUserMedia(
        call.isVideo ? { audio: true, video: true } : { audio: true }
      );
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      await pc.setRemoteDescription(call.offer);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsRef.current.send(JSON.stringify({
        type: "call.answer", payload: { to: currentPeer!.id, answer }
      }));
      setCall({ status: "in-call", pc, localStream, isVideo: call.isVideo });
    } catch (err) {
      setStatus(t("callAcceptFailed"));
      endCall();
    }
  };

  const endCall = () => {
    if (screenShareRef.current) {
      screenShareRef.current.stream.getTracks().forEach((t) => t.stop());
      screenShareRef.current = null;
    }
    call.pc?.close();
    call.localStream?.getTracks().forEach((track) => track.stop());
    stopTone();
    const targetId = peer?.id ?? call.callerId;
    if (targetId && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: "call.end", payload: { to: targetId } }));
    }
    closeCallWindow();
    setCall({ status: "idle" });
  };

  useEffect(() => {
    if (call.status === "calling" || call.status === "in-call") {
      ensureCallWindow(Boolean(call.isVideo));
      syncCallWindowStreams(call.localStream, call.remoteStream);
    } else if (call.status === "idle") { closeCallWindow(); }
  }, [call.status, call.isVideo, call.localStream, call.remoteStream]);

  useEffect(() => {
    if (call.status === "incoming") { startTone("incoming"); return; }
    if (call.status === "calling") { startTone("outgoing"); return; }
    stopTone();
  }, [call.status]);

  // -- Render --
  if (!isAuthed) {
    return (
      <div className="auth-shell">
        <div className="auth">
          <div className="auth-step-head">
            {authStep !== "language" && (
              <button type="button" className="auth-back" onClick={() => {
                setStatus("");
                if (authStep === "method") setAuthStep("language");
                else if (authStep === "code") setAuthStep("phone");
                else setAuthStep("method");
                if (authStep === "qr") { setQrSession(null); setQrDataUrl(""); }
              }}>
                {ta("back")}
              </button>
            )}
            <h1>{t("appName")}</h1>
            <p>
              {authStep === "language" && ta("chooseLanguage")}
              {authStep === "method" && ta("chooseSignIn")}
              {authStep === "phone" && t("authSubtitle")}
              {authStep === "code" && ta("codeTitle")}
              {authStep === "qr" && ta("qrTitle")}
            </p>
          </div>

          {authStep === "language" && (
            <>
              <select className="language-select auth-language" value={language}
                onChange={(e) => handleLanguageChange(e.target.value as Lang)}
                aria-label={t("language")}>
                {languageOptions.map((item) => (
                  <option key={item} value={item}>{languageLabels[item]}</option>
                ))}
              </select>
              <button onClick={() => setAuthStep("method")}>{ta("next")}</button>
            </>
          )}

          {authStep === "method" && (
            <div className="auth-methods">
              <button type="button" className="auth-method" onClick={() => { setStatus(""); setAuthStep("phone"); }}>
                <span>{ta("phoneMethod")}</span>
                <small>{ta("phoneMethodHint")}</small>
              </button>
              <button type="button" className="auth-method" onClick={() => { setStatus(""); setAuthStep("qr"); }}>
                <span>{ta("qrMethod")}</span>
                <small>{ta("qrMethodHint")}</small>
              </button>
            </div>
          )}

          {authStep === "phone" && (
            <>
              <div className="phone-row">
                <div className="select-wrapper" ref={selectRef}>
                  <button type="button" className="select-trigger" onClick={() => setCountryOpen((p) => !p)}>
                    <span>{activeCountry?.name ?? country} (+{activeCountry?.dial ?? dialCode})</span>
                    <span className="chevron" />
                  </button>
                  {countryOpen && (
                    <div className="select-panel">
                      <input className="select-search" placeholder={t("countrySearch")}
                        value={countryQuery} onChange={(e) => setCountryQuery(e.target.value)} />
                      <div className="select-list">
                        {filteredCountries.map((item) => (
                          <button type="button" key={item.code}
                            className={`select-item ${item.code === country ? "active" : ""}`}
                            onClick={() => { setCountry(item.code); setCountryOpen(false); }}>
                            <span>{item.name}</span>
                            <span className="dial">+{item.dial}</span>
                          </button>
                        ))}
                        {filteredCountries.length === 0 && <div className="select-empty">{t("nothingFound")}</div>}
                      </div>
                    </div>
                  )}
                </div>
                <input placeholder={t("phoneNumber")} value={localNumber} onChange={(e) => setLocalNumber(e.target.value)} />
              </div>
              <div className="auth-meta">
                <span className="hint">{t("fullNumber")}: {fullPhone}</span>
              </div>
              <button onClick={requestCode}>{ta("confirmPhone")}</button>
            </>
          )}

          {authStep === "code" && (
            <>
              <p className="auth-copy">{ta("codeHint")}</p>
              <div className="auth-meta">
                <span className="hint">{t("fullNumber")}: {fullPhone}</span>
                <span className={`hint auth-dev ${devCode ? "" : "empty"}`}>{devCode ? `${t("devCode")}: ${devCode}` : " "}</span>
              </div>
              <input placeholder={t("code")} value={code} onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") verifyCode(); }} autoFocus />
              <button onClick={verifyCode}>{t("signIn")}</button>
              <button type="button" className="auth-secondary" onClick={() => { setCode(""); setStatus(""); setAuthStep("phone"); }}>
                {ta("changePhone")}
              </button>
            </>
          )}

          {authStep === "qr" && (
            <>
              <p className="auth-copy">{ta("qrHint")}</p>
              <div className="auth-qr-frame">
                {qrDataUrl ? <img className="auth-qr-image" src={qrDataUrl} alt={ta("qrTitle")} /> : <div className="auth-qr-loading" />}
              </div>
              <button type="button" className="auth-secondary" onClick={startQrLogin}>{ta("qrRetry")}</button>
            </>
          )}

          <div className={`status auth-status ${status ? "" : "empty"}`}>{status || " "}</div>
        </div>
      </div>
    );
  }

  return (
    <div className={`app ${isMenuOpen ? "menu-open" : "menu-closed"}`}>
      <aside className="sidebar">
        <div className="profile">
          <div>
            <div className="profile-row">
              <div className="profile-left"><div className="logo">MAS</div></div>
            </div>
            <div className="sidebar-search">
              <input placeholder={t("chatsSearch")} value={chatQuery}
                onChange={(e) => setChatQuery(e.target.value)} />
            </div>
            {chatQuery.trim().length >= 3 && (
              <div className="chat-people">
                <div className="chat-people-title">{t("people")}</div>
                {loginMatches.length === 0 ? (
                  <div className="chat-empty">{t("nothingFound")}</div>
                ) : (
                  loginMatches.map((item) => (
                    <button key={item.id} className="chat-item" onClick={() => handleSelectUser(item)}>
                      <div className="chat-avatar">
                        {(item.login ?? item.phone).slice(0, 1).toUpperCase()}
                        {onlineUserIds.has(item.id) && <span className="chat-dot" />}
                      </div>
                      <div className="chat-meta">
                        <div className="chat-row">
                          <span className="chat-name">{item.login ?? item.phone}</span>
                          <span className="chat-time">@{item.login}</span>
                        </div>
                        <span className="chat-preview">{item.phone}</span>
                      </div>
                    </button>
                  ))
                )}
              </div>
            )}
            <div className="chat-list">
              {chatItems.length === 0 ? (
                <div className="chat-empty">{t("noChats")}</div>
              ) : (
                chatItems.map((chat) => (
                  <button key={chat.id}
                    className={`chat-item ${peer?.id === chat.id ? "active" : ""}`}
                    onClick={() => handleSelectChat(chat)}>
                    <div className="chat-avatar">
                      {chat.name.slice(0, 1).toUpperCase()}
                      {chat.online && <span className="chat-dot" />}
                    </div>
                    <div className="chat-meta">
                      <div className="chat-row">
                        <span className="chat-name">{chat.name}</span>
                        <span className="chat-time">{chat.time}</span>
                      </div>
                      <span className="chat-preview">{chat.lastMessage}</span>
                    </div>
                    {chat.unread > 0 && <span className="unread-badge">{chat.unread}</span>}
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
        <div className="status">{status}</div>
        {call.status === "incoming" && activeTab === "chat" && (
          <div className="call-card">
            <p>{call.isVideo ? t("incomingVideoCall") : t("incomingCall")}</p>
            <div className="call-card-btns">
              <button className="call-accept" onClick={acceptCall}>{t("accept")}</button>
              <button className="call-reject" onClick={endCall}>{t("decline")}</button>
            </div>
          </div>
        )}
        {call.status === "in-call" && activeTab === "chat" && (
          <div className="call-card">
            <p>{t("activeCall")}</p>
            <button className="call-reject" onClick={endCall}>{t("end")}</button>
          </div>
        )}
        <audio ref={remoteAudioRef} autoPlay />
      </aside>
      <div className="backdrop" onClick={() => setIsMenuOpen(false)} />
      <div className="content">
        <div className="topbar">
          <div className="topbar-left">
            <button className="hamburger" onClick={() => setIsMenuOpen((p) => !p)}>
              <span /><span /><span />
            </button>
            <button className="gear"
              onClick={() => setActiveTab((p) => (p === "settings" ? "chat" : "settings"))}
              aria-label={t("settings")}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M19.14 12.94a7.84 7.84 0 0 0 .05-.94 7.84 7.84 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.2 7.2 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.58.22-1.12.52-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 8.84a.5.5 0 0 0 .12.64l2.03 1.58c-.03.31-.05.63-.05.94s.02.63.05.94l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.51.41 1.05.72 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54c.58-.22 1.12-.52 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64zM12 15.5A3.5 3.5 0 1 1 15.5 12 3.5 3.5 0 0 1 12 15.5z"/>
              </svg>
            </button>
          </div>
          <div className="topbar-title">
            {activeTab === "chat" ? (
              peer ? (
                <span>
                  {peer.login ?? peer.phone}
                  {peerTyping && <span className="typing-label"> {t("typing")}</span>}
                  {!peerTyping && onlineUserIds.has(peer.id) && <span className="online-label"> {t("online")}</span>}
                </span>
              ) : ""
            ) : t("settings")}
          </div>
          {activeTab === "chat" && peer && (
            <div className="call-actions">
              <button className="gear" onClick={() => { setChatSearchOpen((p) => !p); setChatSearch(""); }} aria-label={t("search")} title={t("searchChat")}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="8" fill="none" stroke="currentColor" strokeWidth="2"/><path d="M21 21l-4.35-4.35" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              </button>
              <button className="gear" onClick={clearChat} aria-label={t("clearChat")} title={t("clearChat")}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <button className="video-btn" onClick={() => startCall(true)} aria-label={t("videoCall")}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M15 8a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h10zm7.5 2.5-3.5 2v-3l3.5 2z"/>
                </svg>
              </button>
              <button className="phone-btn" onClick={() => startCall(false)} aria-label={t("audioCall")}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.56.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 6a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.56 1 1 0 0 1-.24 1.02z"/>
                </svg>
              </button>
            </div>
          )}
        </div>
        <main className="chat">
        {activeTab === "chat" ? (
          peer ? (
            <>
              {chatSearchOpen && (
                <div className="chat-search-bar">
                  <input placeholder={t("searchChat")} value={chatSearch} autoFocus
                    onChange={(e) => setChatSearch(e.target.value)} />
                  <span className="chat-search-count">{chatSearch ? `${filteredMessages.length} ${t("found")}` : ""}</span>
                  <button className="ghost" onClick={() => { setChatSearchOpen(false); setChatSearch(""); }}>✕</button>
                </div>
              )}
              {messages.some((m) => m.pinned) && (
                <div className="pinned-bar" onClick={() => {
                  const pinned = messages.find((m) => m.pinned);
                  if (pinned) { const el = document.getElementById(`msg-${pinned.id}`); el?.scrollIntoView({ behavior: "smooth" }); }
                }}>
                  📌 {messages.filter((m) => m.pinned).length} {t("pinnedMessage")}
                </div>
              )}
              <div className="messages">
                {(chatSearch ? filteredMessages : messages).map((msg, idx, arr) => {
                  const prev = arr[idx - 1];
                  const showDate = !prev || formatDate(prev.createdAt, language) !== formatDate(msg.createdAt, language);
                  const replyMsg = msg.replyToId ? messages.find((m) => m.id === msg.replyToId) : null;
                  return (
                    <React.Fragment key={msg.id}>
                      {showDate && <div className="date-separator"><span>{formatDate(msg.createdAt, language)}</span></div>}
                      <div id={`msg-${msg.id}`}
                        className={`message ${msg.isMine ? "out" : "in"} ${msg.meta?.decryptFailed ? "decrypt-failed" : ""} ${msg.pinned ? "pinned-msg" : ""}`}
                        onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, msg }); }}>
                        {msg.pinned && <div className="pin-badge">📌</div>}
                        {replyMsg && (
                          <div className="reply-preview" onClick={() => {
                            const el = document.getElementById(`msg-${replyMsg.id}`);
                            el?.scrollIntoView({ behavior: "smooth" });
                          }}>
                            <span className="reply-author">{replyMsg.isMine ? t("you") : (peer?.login ?? peer?.phone)}</span>
                            <span className="reply-text">{replyMsg.text?.slice(0, 60) ?? "..."}</span>
                          </div>
                        )}
                        {msg.meta?.decryptFailed ? (
                          <div className="decrypt-failed-content">
                            <span className="message-text">{msg.text}</span>
                            <button className="decrypt-delete-btn" onClick={() => deleteMessage(msg.id)}>{t("delete")}</button>
                          </div>
                        ) : msg.contentType === "file" && msg.meta ? (
                          <button className="file-btn" onClick={() => decryptFile(msg)}>📎 {msg.meta.fileName}</button>
                        ) : (
                          <span className="message-text">{msg.text}</span>
                        )}
                        {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                          <div className="reactions-row">
                            {Object.entries(msg.reactions).map(([emoji, users]) => (
                              <button key={emoji} className={`reaction-chip ${(users as string[]).includes(user?.id ?? "") ? "my-reaction" : ""}`}
                                onClick={() => reactToMessage(msg.id, emoji)}>
                                {emoji} {(users as string[]).length}
                              </button>
                            ))}
                            <button className="reaction-chip add-reaction" onClick={() => setReactionPicker(reactionPicker === msg.id ? null : msg.id)}>+</button>
                          </div>
                        )}
                        {reactionPicker === msg.id && (
                          <div className="reaction-picker-row">
                            {quickReactions.map((e) => (
                              <button key={e} className="reaction-pick" onClick={() => reactToMessage(msg.id, e)}>{e}</button>
                            ))}
                          </div>
                        )}
                        <div className="message-meta">
                          {msg.editedAt && <span className="edited-label">{t("edited")}</span>}
                          <span className="message-time">{formatTime(msg.createdAt)}</span>
                          {msg.isMine && !msg.meta?.decryptFailed && (
                            <span className={`message-status ${msg.status ?? "sent"}`}>
                              {msg.status === "read" ? "✓✓" : msg.status === "delivered" ? "✓✓" : "✓"}
                            </span>
                          )}
                        </div>
                      </div>
                    </React.Fragment>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
              {ctxMenu && (
                <div className="ctx-menu" style={{ top: Math.min(ctxMenu.y, window.innerHeight - 300), left: Math.min(ctxMenu.x, window.innerWidth - 220) }}>
                  <div className="ctx-reactions">
                    {quickReactions.map((e) => (
                      <button key={e} className="ctx-react-btn" onClick={() => { reactToMessage(ctxMenu.msg.id, e); setCtxMenu(null); }}>{e}</button>
                    ))}
                  </div>
                  <div className="ctx-divider" />
                  <button className="ctx-item" onClick={() => { startReply(ctxMenu.msg); }}><span className="ctx-icon">↩</span>{t("reply")}</button>
                  {ctxMenu.msg.isMine && <button className="ctx-item" onClick={() => { startEdit(ctxMenu.msg); }}><span className="ctx-icon">✏️</span>{t("edit")}</button>}
                  <button className="ctx-item" onClick={() => { copyMessageText(ctxMenu.msg.text ?? ""); setCtxMenu(null); }}><span className="ctx-icon">📋</span>{t("copy")}</button>
                  <button className="ctx-item" onClick={() => { pinMessage(ctxMenu.msg.id); setCtxMenu(null); }}><span className="ctx-icon">📌</span>{ctxMenu.msg.pinned ? t("unpin") : t("pin")}</button>
                  {ctxMenu.msg.isMine && (<><div className="ctx-divider" /><button className="ctx-item ctx-danger" onClick={() => { deleteMessage(ctxMenu.msg.id); setCtxMenu(null); }}><span className="ctx-icon">🗑</span>{t("delete")}</button></>)}
                </div>
              )}
              <div className="composer">
                {showEmoji && (
                  <div className="emoji-picker">
                    <div className="emoji-header">
                      <input className="emoji-search" placeholder={t("emojiSearch")} value={emojiSearch}
                        onChange={(e) => setEmojiSearch(e.target.value)} autoFocus />
                    </div>
                    <div className="emoji-tabs">
                      {Object.keys(emojiCategories).map((cat) => (
                        <button key={cat} className={`emoji-tab ${emojiCategory === cat ? "active" : ""}`}
                          onClick={() => { setEmojiCategory(cat); setEmojiSearch(""); }}>
                          {cat === "Обличчя" ? "😀" : cat === "Жести" ? "👋" : cat === "Серця" ? "❤️" : cat === "Об'єкти" ? "⭐" : "✅"}
                        </button>
                      ))}
                    </div>
                    <div className="emoji-grid">
                      {(emojiSearch
                        ? allEmojis.filter((e) => e.includes(emojiSearch))
                        : emojiCategories[emojiCategory] ?? []
                      ).map((e) => (
                        <button key={e} className="emoji-btn" onClick={() => setMsgInput((p) => p + e)}>{e}</button>
                      ))}
                    </div>
                  </div>
                )}
                {(replyTo || editingMsg) && (
                  <div className="composer-reply-bar">
                    <div className="composer-reply-info">
                      <span className="composer-reply-label">{editingMsg ? `✏ ${t("editing")}` : `↩ ${replyTo?.isMine ? t("you") : (peer?.login ?? peer?.phone)}`}</span>
                      <span className="composer-reply-text">{(editingMsg ?? replyTo)?.text?.slice(0, 80)}</span>
                    </div>
                    <button className="composer-reply-close" onClick={cancelReplyEdit}>✕</button>
                  </div>
                )}
                <div className="composer-row">
                  <button className="emoji-toggle" onClick={() => setShowEmoji((p) => !p)}>😀</button>
                  <textarea placeholder={t("message")} value={msgInput} rows={1}
                    onChange={(e) => { setMsgInput(e.target.value); sendTyping(); if (showEmoji) setShowEmoji(false); }}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSendText(); } }} />
                  <button className="send-btn" onClick={handleSendText} disabled={!msgInput.trim()}>
                    <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
                  </button>
                  <label className="attach-btn" aria-label={t("attachFile")}>
                    <input type="file" onChange={(e) => handleFile(e.target.files?.[0] ?? null)} />
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M16.5 6.5 8.5 14.5a2.5 2.5 0 0 0 3.54 3.54l8.25-8.25a4 4 0 0 0-5.66-5.66l-8.6 8.6a5.5 5.5 0 0 0 7.78 7.78l8.07-8.07"/>
                    </svg>
                  </label>
                </div>
              </div>
            </>
          ) : (
            <div className="chat-placeholder">
              <div>
                <h2>MAS Secure Messenger</h2>
                <p>{t("chatPlaceholder")}</p>
              </div>
            </div>
          )
        ) : (
          <div className="settings">
            <h2>{t("settings")}</h2>
            <div className="settings-grid">
              <section className="settings-section">
                <h3>{t("program")}</h3>
                <label className="settings-row">
                  <span>{t("notifications")}</span>
                  <input className="toggle" type="checkbox" checked={notificationsEnabled}
                    onChange={(e) => handleNotificationsChange(e.target.checked)} />
                </label>
                <label className="settings-row">
                  <span>{t("language")}</span>
                  <select className="language-select" value={language} onChange={(e) => handleLanguageChange(e.target.value as Lang)}>
                    {languageOptions.map((option) => (
                      <option key={option} value={option}>{languageLabels[option]}</option>
                    ))}
                  </select>
                </label>
              </section>
              <section className="settings-section">
                <h3>{t("account")}</h3>
                <label className="settings-row column">
                  <span>{t("login")}</span>
                  <input value={loginValue} onChange={(e) => setLoginValue(e.target.value)} placeholder={t("loginPlaceholder")} />
                </label>
                <div className="settings-row">
                  <span>{t("uniqueLogin")}</span>
                  <button className="ghost" onClick={saveLogin}>{t("save")}</button>
                </div>
                <div className="settings-row">
                  <span>{t("phone")}</span>
                  <span className="muted">{user?.phone}</span>
                </div>
                <div className="settings-row">
                  <span>{t("session")}</span>
                  <button className="ghost" onClick={logout}>{t("logout")}</button>
                </div>
              </section>
              <section className="settings-section">
                <h3>{t("keys")}</h3>
                <div className="settings-row">
                  <span>{t("backup")}</span>
                  <span className="muted">{backupAvailable ? t("available") : t("notCreated")}</span>
                </div>
                <label className="settings-row column">
                  <span>{t("masPin")}</span>
                  <input type="password" value={backupPin} onChange={(e) => setBackupPin(e.target.value)} />
                </label>
                <div className="settings-row">
                  <span>{t("saveKey")}</span>
                  <button className="ghost" onClick={saveKeyBackup}>{t("save")}</button>
                </div>
                <label className="settings-row column">
                  <span>{t("restorePin")}</span>
                  <input type="password" value={restorePin} onChange={(e) => setRestorePin(e.target.value)} />
                </label>
                <div className="settings-row">
                  <span>{t("restoreKey")}</span>
                  <button className="ghost" onClick={restoreKeyBackup}>{t("restoreKey")}</button>
                </div>
              </section>
              <section className="settings-section">
                <h3>{t("privacy")}</h3>
                <label className="settings-row">
                  <span>{t("readReceipts")}</span>
                  <input className="toggle" type="checkbox" checked={readReceipts}
                    onChange={(e) => setReadReceipts(e.target.checked)} />
                </label>
                <label className="settings-row">
                  <span>{t("typingIndicator")}</span>
                  <input className="toggle" type="checkbox" checked={typingIndicator}
                    onChange={(e) => setTypingIndicator(e.target.checked)} />
                </label>
              </section>
            </div>
          </div>
        )}
      </main>
      </div>
    </div>
  );
}
