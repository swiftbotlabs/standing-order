#!/bin/bash
# "Coins with rules" hero cut, 1080x1920, ~27 s: benefit card -> customer line -> the rule -> refused early -> cancel -> end card.
set -e; cd "$(dirname "$0")"; ROOT=$(cd .. && pwd)
H=$ROOT/hero; V=$H/render/film.video.mp4; FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf; O=$H/out; mkdir -p $O
seg() { ffmpeg -loglevel error -y -ss $2 -t $3 -i $V -an -vf "fps=30,scale=1080:1920,setsar=1" -c:v libx264 -crf 16 -pix_fmt yuv420p $O/$1.mp4; }
seq_() { ffmpeg -loglevel error -y -framerate 30 -i $H/cards/$2/f%05d.jpg -vf "scale=1080:1920,setsar=1" -c:v libx264 -crf 16 -pix_fmt yuv420p $O/$1.mp4; }
seq_ A title; seg B 0.0 4.4; seg C 21.0 7.8; seg D 41.0 4.0; seg E 48.0 5.8; seq_ F end
printf "file '%s'\n" $O/A.mp4 $O/B.mp4 $O/C.mp4 $O/D.mp4 $O/E.mp4 $O/F.mp4 > $O/list.txt
ffmpeg -loglevel error -y -f concat -safe 0 -i $O/list.txt -c copy $O/joined.mp4
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 $O/joined.mp4)
# captions (big, readable muted on a phone): [text, from, to]
python3 - "$O" <<'PY'
import sys
caps=[("I cancelled it in March.",2.75,4.6,58,1560),("It charged me again in April!",4.6,7.0,58,1560),
("Lock a budget in a contract.",7.1,10.2,56,1560),("One payment a month.",10.2,12.0,58,1560),("Never more, never early.",12.0,14.8,58,1560),
("Take it early?",14.9,16.4,58,1560),("The network itself says no.",16.4,18.8,56,1560),("real mainnet test, 10-minute period",15.2,18.8,34,1680),
("Cancel, and the rest",18.9,21.0,58,1560),("comes straight back.",21.0,22.4,58,1560),("Cancelled means cancelled.",22.4,24.6,58,1560)]
out=sys.argv[1]; f=[]
for i,(t,a,b,fs,y) in enumerate(caps):
    open(f"{out}/c{i}.txt","w").write(t)
    f.append(f"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:textfile={out}/c{i}.txt:fontsize={fs}:fontcolor=white:box=1:boxcolor=0x14201A@0.88:boxborderw={max(14,fs//2-3)}:x=(w-text_w)/2:y={y}:enable='between(t,{a},{b})'")
open(f"{out}/caps.txt","w").write(",".join(f))
PY
ffmpeg -loglevel error -y -i $O/joined.mp4 -vf "$(cat $O/caps.txt),format=yuv420p" -c:v libx264 -crf 17 -preset medium $O/captioned.mp4
# audio: narration at its slots + the film's CC0 music bed ducked under the voice
A=$H/vo
ffmpeg -loglevel error -y -i $A/h1.mp3 -i $A/h2.mp3 -i $A/h3.mp3 -i $A/h4.mp3 -i $A/h5.mp3 -i $ROOT/sound/music.flac -filter_complex \
"[0]adelay=200|200[a0];[1]adelay=2700|2700[a1];[2]adelay=7100|7100[a2];[3]adelay=14900|14900[a3];[4]adelay=18900|18900[a4];\
[a0][a1][a2][a3][a4]amix=inputs=5:normalize=0,apad[vo];[vo]asplit[vo1][vo2];\
[5]atrim=0:$D,volume=0.35,afade=t=in:d=0.6,afade=t=out:st=$(python3 -c "print($D-1.5)"):d=1.5[m];[m][vo1]sidechaincompress=threshold=0.03:ratio=6:attack=20:release=400[md];\
[md][vo2]amix=inputs=2:normalize=0,atrim=0:$D,loudnorm=I=-14:TP=-1.5:LRA=11[out]" -map "[out]" -ar 48000 $O/mix.wav
ffmpeg -loglevel error -y -i $O/captioned.mp4 -i $O/mix.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart $O/coins-with-rules-hero-1080x1920.mp4
ffprobe -v error -show_entries format=duration,size -of compact $O/coins-with-rules-hero-1080x1920.mp4
