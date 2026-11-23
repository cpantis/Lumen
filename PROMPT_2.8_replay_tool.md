# Prompt – Aplicație web de replay (sub-challenge 2.8, dotLumen SW Test Challenge v4)

> Copiază tot ce e sub linie într-un asistent de programare (Claude Code etc.).

---

## Rol și context

Ești un inginer software senior, cu experiență în ROS 2, vizualizare de date de la senzori și aplicații web performante. Construiește de la zero o **aplicație web de replay** pentru o înregistrare ROS 2 în format **MCAP**, făcută cu ochelarii .lumen (dispozitiv purtabil care ghidează persoane nevăzătoare sau cu deficiențe de vedere) în timp ce utilizatorul mergea pe stradă.

Înregistrarea conține mai multe fluxuri de date:
- **intrări**, produse de senzorii ochelarilor (de exemplu două camere cu câmpuri vizuale diferite: una orientată înainte, alta în jos spre sol, plus, posibil, IMU, adâncime/stereo, `CameraInfo`, `TF`);
- **ieșiri**, produse de o componentă software nedocumentată care combină unele intrări și scoate un al treilea tip de date pentru **două câmpuri vizuale (FOV)**, fiecare cu mai multe tipuri de ieșire.

Nu ai documentație, nu ai codul componentei și nu ai voie să presupui nume de topicuri sau tipuri de mesaje. **Aplicația trebuie să descopere singură** topicurile, tipurile și schemele din fișier.

**Scopul aplicației:** o persoană trebuie să poată vedea, **în orice moment al înregistrării**, ce a intrat în componentă și ce a ieșit din ea, cu toate fluxurile sincronizate în timp.

## Constrângeri tehnice

- **Nu se instalează ROS.** Citirea se face direct din MCAP.
- Recomandat: aplicație 100% client-side, **TypeScript + React + Vite**:
  - `@mcap/core` pentru citire indexată (`McapIndexedReader`) dintr-un `File`/`Blob` încărcat prin drag & drop, fără să fie citit tot fișierul în memorie (înregistrarea poate avea câțiva GB);
  - `@foxglove/rosmsg` + `@foxglove/rosmsg2-serialization` pentru decodare CDR pe baza schemelor `ros2msg` din fișier (cu suport și pentru `ros2idl` dacă apare);
  - `three.js` (sau `@react-three/fiber`) pentru 3D, Canvas 2D/WebGL pentru imagini, `uPlot` (sau echivalent) pentru serii de timp.
- Decodarea și indexarea rulează în **Web Workers**, ca UI-ul să nu se blocheze. Folosește un cache LRU de mesaje decodate și prefetch în jurul cursorului de timp.
- Ținte de performanță: interfața rămâne fluidă (≥ 30 fps la redare 1×) cu toate panourile deschise; un salt la un timestamp oarecare se face în < 500 ms.
- Pornire cu o singură comandă: `npm install && npm run dev`, plus un `Dockerfile` sau `npm run build` care produce un site static.
- Alternativă acceptată, dacă browserul nu face față volumului: un backend Python (FastAPI + `mcap` + `mcap-ros2-support`) care indexează fișierul și servește mesajele decodate sau imaginile pe endpointuri, cu același frontend. Justifică alegerea în README.

## Funcționalități obligatorii

### 1. Încărcare și inventar
- Drag & drop sau selectare de fișier `.mcap`, cu bară de progres la indexare.
- Tabel de inventar: topic, tip de mesaj, encoding, număr de mesaje, frecvență medie, jitter (deviația standard a intervalului dintre mesaje), cel mai mare gol, primul și ultimul timestamp.
- Fiecare topic primește o clasificare **Intrare / Ieșire / Necunoscut**, cu o euristică propusă automat: tipuri de senzor (`Image`, `CompressedImage`, `Imu`, `CameraInfo`) → intrare; restul → ieșire candidat. Utilizatorul o poate edita, iar clasificarea și asocierea fiecărui topic cu un FOV se salvează în `localStorage` și se pot exporta sau importa ca JSON.

### 2. Timeline și control al redării
- Play / pause, viteze 0.1× … 4×, buclă pe un interval selectat, pas înainte și înapoi **cu un cadru pentru un topic ales** (de exemplu „următorul mesaj de pe topicul de ieșire X”).
- Bară de scrub cu un rând per topic, pe care fiecare mesaj apare ca o bifă. **Golurile** (interval > k × perioada mediană, cu k configurabil, implicit 2) sunt evidențiate cu roșu; mesajele goale sau invalide au altă culoare.
- Afișarea timpului curent atât absolut (UTC, ns), cât și relativ la începutul înregistrării.
- Comenzi din tastatură: Space, ←/→ (cadru), Shift+←/→ (±1 s), `[` `]` (viteză).
- Starea se salvează în URL (timp curent, layout, topicuri vizibile), ca un anumit moment să poată fi trimis printr-un link.

### 3. Sincronizare
- Selector pentru sursa timpului: **log time** (momentul înregistrării în bag) sau **`header.stamp`** (momentul de achiziție sau procesare, acolo unde există).
- Pentru fiecare panou se afișează ultimul mesaj cu timestamp ≤ timpul curent, împreună cu **vârsta** lui (t_curent − t_mesaj). Panoul devine portocaliu sau roșu când vârsta depășește 1,5× sau 3× perioada nominală a topicului (date expirate).
- **Asocierea ieșire → intrare:** pentru mesajul de ieșire curent se caută intrările folosite, prin potrivire exactă de `header.stamp` sau, dacă nu există, prin cea mai apropiată intrare anterioară. Se afișează **latența** (log_time ieșire − stamp intrare) și se evidențiază cadrele de intrare corespunzătoare în panourile lor.
- Afișaj live al latenței și un mini-grafic al latenței pe toată înregistrarea, cu cursor sincronizat.

### 4. Panouri de vizualizare (alese automat după tipul mesajului)
- `sensor_msgs/Image` și `CompressedImage`: afișare corectă pentru encodingurile `rgb8`, `bgr8`, `mono8`, `mono16`, `16UC1`, `32FC1` (adâncime cu colormap configurabil și interval min/max), JPEG/PNG. Pixelul de sub cursor își arată valoarea reală, inclusiv în unități.
- `sensor_msgs/PointCloud2`: vizualizare 3D (orbit camera), colorare după x, y, z, intensitate sau orice câmp, dimensiune configurabilă a punctelor, afișarea numărului de puncte și a procentului de puncte NaN sau invalide.
- `nav_msgs/OccupancyGrid`, `sensor_msgs/LaserScan`, `visualization_msgs/Marker(Array)`, `geometry_msgs/*Stamped`: randare 2D sau 3D adecvată.
- `sensor_msgs/Imu`: grafice pentru accelerație, viteză unghiulară și orientare (roll, pitch, yaw), cu cursorul de timp sincronizat.
- `tf2_msgs/TFMessage` (`/tf`, `/tf_static`): arborele de frame-uri și axele afișate în scena 3D.
- `CameraInfo`: rezoluție, K, D, P, afișate ca text.
- **Fallback generic** pentru orice alt tip: arbore JSON al mesajului, plus posibilitatea de a reprezenta grafic **orice câmp numeric** ca serie de timp, prin selectarea căii (de exemplu `msg.data[3]`).

### 5. Layout orientat pe componentă
- Layout implicit în trei coloane: **Intrări | Ieșiri FOV 1 | Ieșiri FOV 2**, cu panouri redimensionabile și rearanjabile (de exemplu cu `react-grid-layout`). Layoutul se poate salva și încărca.
- Antetul fiecărui panou arată: topicul, tipul, frecvența, vârsta mesajului, indexul mesajului (n / N) și starea (OK / expirat / gol / invalid).

### 6. Suprapuneri pentru verificarea consistenței (legat de 2.3)
- Proiectarea ieșirii 3D a unui FOV (point cloud sau adâncime) **peste imaginea camerei** corespunzătoare, folosind `CameraInfo` și `TF`. Dacă lipsesc, aplicația permite introducerea manuală a intrinsecilor sau extrinsecilor (fx, fy, cx, cy, translație, rotație), cu valori salvate și exportabile.
- Comparație vizuală între două ieșiri ale aceluiași FOV pentru același moment: overlay cu transparență reglabilă și o hartă de diferențe, acolo unde au aceeași geometrie.

### 7. Integrare cu raportul de teste (legat de 2.4)
- Import al unui fișier JSON cu eșecuri de forma `[{ "requirement": "REQ-xx", "topic": "...", "t_start_ns": ..., "t_end_ns": ..., "measured": ..., "limit": ..., "message": "..." }]`.
- Eșecurile apar ca markere pe timeline și într-o listă laterală; un click pe eșec face salt la momentul respectiv.
- Bookmarkuri manuale cu notă, exportabile ca JSON.

### 8. Export
- Captură PNG a întregului layout la momentul curent.
- Export al unui interval ca video WebM (prin `MediaRecorder` pe canvas compus), opțional.
- Export CSV pentru seriile reprezentate grafic.

## Robustețe
- Aplicația nu se blochează la mesaje corupte, scheme lipsă, encodinguri necunoscute sau topicuri fără `header`. Un astfel de mesaj apare ca „nu pot decoda” și se continuă cu restul.
- Fișiere neindexate sau trunchiate: fallback pe citire secvențială (`McapStreamReader`) cu avertisment.
- Nimic nu e hardcodat: nume de topicuri, frame-uri, rezoluții și număr de FOV-uri se deduc din fișier sau din configurația utilizatorului.

## Calitate și livrabile
- Cod TypeScript strict, modular (`reader/`, `decode/`, `sync/`, `panels/`, `timeline/`, `state/`), cu JSDoc pe funcțiile publice.
- **Teste unitare** (Vitest) pentru logica critică: căutarea ultimului mesaj ≤ t (binary search), detectarea golurilor, calculul frecvenței și jitterului, asocierea ieșire → intrare după stamp, decodarea encodingurilor de imagine. Adaugă un mic fișier MCAP sintetic, generat de un script din repo, pentru teste reproductibile.
- Un **test end-to-end** (Playwright): încarcă MCAP-ul sintetic, rulează play, face scrub și verifică faptul că panourile se actualizează.
- `README.md` cu: arhitectura (diagramă), cum se rulează (o singură comandă), cum se folosește (GIF sau capturi), limitări cunoscute și presupuneri.
- Un paragraf gata de inclus în secțiunea „Implementation” a documentului challenge-ului, care descrie tool-ul, deciziile tehnice și cum ajută la analiza componentei.

## Mod de lucru
1. Începe cu un script de inspecție care listează topicurile, tipurile, schemele și statisticile din fișierul real, ca să confirmi ce trebuie suportat.
2. Implementează incremental: reader + inventar → timeline + sincronizare → panouri de imagine → 3D → asociere ieșire → intrare și latență → suprapuneri → import de raport → export.
3. După fiecare etapă, rulează testele și verifică vizual în browser.
4. Declară explicit orice presupunere făcută acolo unde datele nu spun ceva.
