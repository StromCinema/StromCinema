
STRØM CINEMA for Windows  -  version 0.1.0
=====================================

Strøm Cinema is a movie shelf with a built-in server and mpv playback. The same
program also serves your library to the Strøm Android TV app on your network.


<img width="2139" height="896" alt="Screenshot 2026-11-16 220541" src="https://github.com/user-attachments/assets/57afe829-1d8f-44ab-a155-1c9ffd4a685a" />

<img width="2182" height="932" alt="Screenshot 2026-11-16 220655" src="https://github.com/user-attachments/assets/be10591e-b895-4533-ae1d-29e86a2e420a" />

<img width="2119" height="909" alt="Screenshot 2026-11-16 220734" src="https://github.com/user-attachments/assets/5059c03c-b159-4832-9df4-eb3bbf28b59c" />
<img width="2179" height="932" alt="Screenshot 2026-11-16 220713" src="https://github.com/user-attachments/assets/a4f1f362-ccf4-4abb-9c51-ac3b94b35de5" />
<img width="2160" height="873" alt="Screenshot 2026-11-16 220755" src="https://github.com/user-attachments/assets/f720f20c-6246-4b35-928c-6966959da017" />
<img width="682" height="658" alt="Screenshot 2026-11-16 220817" src="https://github.com/user-attachments/assets/e5b2a18e-b51a-43a7-bce2-c3adc7c6b99e" />

<img width="989" height="809" alt="Screenshot 2026-11-16 220851" src="https://github.com/user-attachments/assets/9764ef07-3151-4b8a-8822-544c6fad6388" />



Start Strom.exe. On the first start the settings window opens: add your movie
folders and (optionally) your TMDB key, then Save.


WHERE EVERYTHING IS SAVED
-------------------------
Nothing is saved inside this program folder. All settings and data live in:

    %APPDATA%\Strom
    (usually C:\Users\<your name>\AppData\Roaming\Strom)

Paste that path into the Windows Explorer address bar to open it.
This folder is created by Strøm on first start. Deleting or moving the
program folder does not touch your settings.

  strom-config.json     Your settings: movie folders, your TMDB key, mpv and
                        ffmpeg paths, audio passthrough, server-only mode,
                        and the shelf look / playback preferences.
                        (If an older plexus-config.json is already in the
                        folder and strom-config.json is not, that file is
                        used instead.)
  data\tv-metadata.json What Strøm found at TMDB for your films and series:
                        title, year, description, poster path, and (once a
                        title is opened) runtime, genres, director, cast
                        and trailer links.
  data\tv-posters\      Poster images downloaded from TMDB (a cache).
  data\tv-progress.json Where you stopped in each film (resume position).
  data\tv-debug.log     Debug lines from the TV app, only if you use its
                        debug overlay.
  trickplay\            Seek-preview thumbnails made with ffmpeg
                        (<id>.json and <id>-0.jpg, <id>-1.jpg ...).
                        See "SEEK PREVIEWS (TRICKPLAY)" below.
  converted\            Audio-converted copies of films (TrueHD / DTS-HD ->
                        Dolby Digital 5.1) for TVs that cannot play them.
                        At most 2 are kept, the oldest is deleted.
  mpv-input.conf        Key bindings that Strøm generates for mpv.
  (other folders)       Cache, Local Storage and similar: created by the
                        program window itself.

Your film files stay in the folders you chose. The only copies Strøm makes
of film content are the audio-converted files in "converted\" (see above).


SEEK PREVIEWS (TRICKPLAY)
-------------------------
Trickplay (also written "trick play", or called seek previews or preview
thumbnails) is the small picture that appears above the seek bar when you
move through a film. It shows roughly what is on screen at the point you are
jumping to, so you can find a scene without guessing and without having to
jump there first. Streaming services and media servers such as Netflix,
YouTube, Plex and Jellyfin offer the same thing.

The name comes from "trick modes" in video playback: fast-forward, rewind and
jumping around, as opposed to normal playback.

Why it has to be prepared in advance:
A film file is stored as a compressed video stream. To show a picture from,
say, 1 hour 12 minutes into the film, a player has to find the nearest full
frame before that point and decode forward from there. Doing that on the fly,
for a film that sits on a PC and is sent over the network to a TV, is too slow
to keep up while you move along the seek bar.
So Strøm does the work once, beforehand: it takes snapshots at regular
intervals and keeps them as ready-made pictures, a bit like a contact sheet or
a film strip of the whole film. While you scrub, the TV only has to pick the
right snapshot, which is instant. The snapshots are 5 seconds apart, so the
preview can differ slightly from the exact spot where you end up.

How it works here:
  - ffmpeg takes one small frame (320 x 180) every 5 seconds of the film and
    puts 100 of them in one JPEG "sheet" (10 x 10 tiles = 500 seconds of
    film per sheet), plus a small .json file that describes the grid. A
    2-hour film becomes about 15 sheets. They are saved in trickplay\.
  - The Android TV app downloads the sheets when playback starts and cuts the
    right tile out of them while you scrub. No video has to be decoded at
    that moment, so scrubbing stays smooth.
  - The sheets are made in the background on the PC, one film at a time,
    after Strøm has scanned your folders. A film you open jumps to the front
    of the line, so a film that has not been processed yet may get its
    previews a little later. Films are processed again if the film file
    changes.
  - It needs ffmpeg. Without ffmpeg nothing is made and the TV shows no
    preview (playback itself still works).
  - It uses CPU and disk space on the PC while it works. The amount depends on
    your library; delete the trickplay\ folder if you need the space.
  - The built-in mpv player on the PC has its own seek bar and does not use
    these pictures.

To switch it off, close Strøm and add this to strom-config.json (inside the
"tv" section; add the section if there is none):

    "tv": { "trickplay": "off" }

Set it to "on" (or remove the line) to turn it back on. The trickplay\ folder
can be deleted at any time; it is made again when needed.


YOUR TMDB KEY
-------------
Strøm uses TMDB to find titles, descriptions and posters. You need your own
free key from https://www.themoviedb.org (Settings -> API). Enter it in the
Strøm settings window.

The key is stored as plain text in strom-config.json. Do NOT share that file,
and do not upload %APPDATA%\Strom (or a zip of it) anywhere public.
A key that is accidentally shared can be deleted and replaced at TMDB.

When Strøm looks up a film it sends a search text taken from the file or
folder name (and the year, if the name has one) to api.themoviedb.org. Poster
images come from image.tmdb.org. The film files themselves are never
uploaded. Trailers open on youtube.com in your web browser when you choose
them.


CLEANING UP / RESETTING
-----------------------
Close Strøm first.

  - Delete trickplay\ or converted\       : safe, they are made again when
                                            needed.
  - Delete data\tv-posters\               : posters are downloaded again
                                            from TMDB when needed.
  - Delete data\tv-progress.json          : forgets all resume positions.
  - Delete data\tv-metadata.json          : titles and posters are looked up
                                            at TMDB again.
  - Delete strom-config.json              : resets all settings, including
                                            your folders and TMDB key.
  - Delete the whole %APPDATA%\Strom      : completely fresh start.


mpv AND ffmpeg
--------------
Films are played with mpv (folder "mpv" next to Strom.exe). ffmpeg.exe next
to Strom.exe is used for audio conversion and seek-preview thumbnails.
Both are separate programs, started by Strøm, with their own licenses.
See THIRD-PARTY-NOTICES.txt and the "licenses" folder.
If you replace them with your own copies, you can set their locations in
the Strøm settings window.


THE ANDROID TV APP
------------------
The TV app only shows your library and plays it. All settings (folders, TMDB
key) stay on this PC. The TV app finds this PC on your network automatically,
or you can type the PC's address: its IP address and port 5000, for example
192.168.1.20:5000 (Strøm uses another port if 5000 is busy). The PC and the TV
must be on the same network.
Strøm serves the TV over plain http, with no encryption and no password.
Anyone on the same network who can reach the port can open the setup page
(http://<PC address>:5000/setup), change the settings and see your TMDB key.
Use Strøm only on a network you trust (your home network), allow it through
Windows Firewall for Private networks only, and never open the port to the
internet.


CREDITS
-------
This product uses the TMDB API but is not endorsed or certified by TMDB.
