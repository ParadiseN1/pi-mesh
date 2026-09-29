export const agentColors = [
  "#b5a1d8",
  "#a9cbbb",
  "#e4ac87",
  "#85b7d1",
  "#d7a0af",
  "#d8c17e",
  "#9faddd",
  "#a9c787",
  "#cda1cd",
  "#83c6bc",
];
export const statusNames = {
  starting: "Connecting",
  working: "Working",
  waiting: "Waiting",
  stopped: "Offline",
  error: "Needs attention",
};

export function deskPositions(count) {
  const columns = count <= 4 ? Math.max(2, count) : 5;
  const rows = Math.ceil(count / columns);
  const gap = rows > 3 ? 94 : rows > 2 ? 118 : 160;
  const firstY = rows > 3 ? 268 : rows > 2 ? 282 : 310;
  return Array.from({ length: count }, (_, index) => {
    const row = Math.floor(index / columns),
      col = index % columns;
    const inRow = Math.min(columns, count - row * columns);
    return {
      x: 480 + (col - (inRow - 1) / 2) * 151,
      y: firstY + row * gap,
      scale: rows > 3 ? 0.6 : rows > 2 ? 0.75 : 1,
    };
  });
}

export function createOffice(canvas) {
  const c = canvas.getContext("2d");
  c.imageSmoothingEnabled = false;
  let snapshot = { run: null, messages: [] };
  let frame = 0;
  let lastDraw = 0;
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  function r(x, y, w, h, color) {
    c.fillStyle = color;
    c.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }
  function text(value, x, y, color = "#e1d8e8", size = 10, align = "left") {
    c.fillStyle = color;
    c.font = `${size}px monospace`;
    c.textAlign = align;
    c.textBaseline = "top";
    c.fillText(value, Math.round(x), Math.round(y));
  }
  function clipped(value, width) {
    return value.length > width ? value.slice(0, width - 1) + "…" : value;
  }
  function line(x1, y1, x2, y2, color, width = 1) {
    c.strokeStyle = color;
    c.lineWidth = width;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x2, y2);
    c.stroke();
  }

  function plant(x, y, size = 1) {
    c.save();
    c.translate(x, y);
    c.scale(size, size);
    r(-12, 18, 30, 8, "#665b7660");
    r(-9, 3, 22, 19, "#a86f60");
    r(-12, 0, 28, 6, "#d79a7b");
    r(-4, 7, 6, 12, "#c88b70");
    r(1, -35, 4, 37, "#50755b");
    r(-12, -31, 15, 8, "#719772");
    r(-17, -27, 16, 8, "#668668");
    r(-10, -21, 12, 6, "#4d745b");
    r(5, -39, 10, 8, "#9bb288");
    r(5, -32, 18, 8, "#6e936b");
    r(5, -26, 11, 7, "#58775b");
    r(-5, -48, 10, 14, "#789f76");
    r(-2, -49, 7, 8, "#9cbd8d");
    c.restore();
  }

  function windowAt(x, y, flip) {
    r(x - 5, y - 5, 172, 112, "#81728f");
    r(x, y, 162, 96, "#7c87a7");
    r(x + 4, y + 4, 154, 24, "#9096b7");
    r(x + 4, y + 28, 154, 20, "#b2a0be");
    r(x + 4, y + 48, 154, 20, "#d5b1be");
    r(x + (flip ? 28 : 115), y + 15, 14, 14, "#f0d5bc");
    r(x + (flip ? 25 : 112), y + 18, 20, 8, "#f0d5bc");
    for (let i = 0; i < 8; i++) {
      const height = 16 + ((i * 17 + (flip ? 19 : 7)) % 35);
      r(
        x + 4 + i * 19,
        y + 92 - height,
        17,
        height,
        i % 2 ? "#626d91" : "#747895",
      );
      for (let k = 0; k < 3; k++)
        if ((i + k) % 3)
          r(x + 8 + i * 19, y + 96 - height + k * 10, 3, 4, "#d9be9a");
    }
    r(x + 77, y, 8, 98, "#b8a6be");
    r(x, y + 94, 162, 9, "#ded0cd");
    r(x - 6, y + 103, 174, 8, "#9a8099");
    r(x - 6, y + 111, 174, 4, "#8b7390");
    r(x - 10, y - 8, 7, 108, "#cab4c4");
    r(x + 165, y - 8, 7, 108, "#cab4c4");
  }

  function background() {
    r(0, 0, 960, 620, "#bcb0c4");
    r(0, 0, 960, 17, "#706b89");
    r(0, 17, 960, 7, "#96859f");
    r(0, 24, 960, 5, "#cec0d0");
    r(0, 29, 960, 181, "#b9aabd");
    r(0, 29, 960, 9, "#b0a0b4");
    for (let x = 0; x < 960; x += 80) r(x, 34, 1, 176, "#a99bad44");
    r(0, 210, 960, 13, "#8c7990");
    r(0, 212, 960, 4, "#d7c0c6");
    r(0, 223, 960, 397, "#c59b83");
    for (let y = 224; y < 620; y += 32) {
      const row = (y - 224) / 32;
      for (let x = -((row % 2) * 50); x < 960; x += 100) {
        r(
          x + 1,
          y + 1,
          98,
          30,
          ["#cda98e", "#cba38b", "#d0ac91", "#c49d85"][
            (Math.floor((x + 100) / 100) + row) % 4
          ],
        );
        r(x + 7, y + 10, 35 + ((row * 11) % 37), 1, "#b58c7833");
        r(x + 45, y + 24, 41, 1, "#edc4a033");
      }
      r(0, y, 960, 1, "#b58d79");
    }
    r(0, 223, 960, 9, "#76627833");
    windowAt(62, 65, false);
    windowAt(736, 65, true);
    // A clock and two pendant lights above the work area.
    r(263, 82, 26, 26, "#746780");
    r(267, 86, 18, 18, "#e5d5ca");
    r(275, 88, 2, 10, "#827383");
    r(275, 96, 7, 2, "#827383");
    for (const x of [37, 921]) {
      r(x, 29, 2, 26, "#746980");
      r(x - 8, 55, 18, 8, "#e5b987");
      r(x - 12, 63, 26, 7, "#f0cf9f");
      r(x - 7, 70, 16, 4, "#ffe2b2");
    }
    // Shelf, a little coffee corner, and office plants.
    r(23, 282, 58, 11, "#8b6f70");
    r(27, 293, 6, 22, "#8d7475");
    r(69, 293, 6, 22, "#8d7475");
    r(35, 257, 24, 25, "#535c6d");
    r(37, 260, 20, 10, "#76838a");
    r(42, 272, 9, 7, "#343b4c");
    r(62, 271, 9, 10, "#ece0cf");
    r(70, 273, 3, 5, "#ece0cf");
    plant(37, 383, 1.1);
    plant(912, 307, 1.12);
    plant(889, 580, 1.2);
    r(27, 475, 65, 61, "#766d87");
    r(30, 478, 59, 14, "#aaa0b0");
    r(30, 496, 59, 14, "#a397a9");
    r(30, 514, 59, 17, "#95889e");
    r(41, 463, 12, 12, "#d7bd92");
    r(55, 456, 8, 19, "#aab89c");
    r(65, 460, 11, 15, "#d3a4a1");
    // A soft rug and the entrance at the front of the room.
    r(375, 582, 210, 33, "#af857b");
    r(381, 587, 198, 22, "#bc998b");
    for (let i = 0; i < 20; i++) r(383 + i * 10, 581, 2, 4, "#cca99a");
    text("MAKE GOOD THINGS TOGETHER", 480, 594, "#815f61", 9, "center");
    r(0, 610, 960, 10, "#967984");
    r(0, 610, 960, 3, "#dfbca0");
  }

  function board() {
    const x = 304,
      y = 54,
      width = 352,
      height = 150;
    r(x + 5, y + 7, width, height, "#76677f55");
    r(x - 5, y - 5, width + 10, height + 10, "#685d75");
    r(x - 2, y - 2, width + 4, height + 4, "#d8c1aa");
    r(x, y, width, height, "#252c39");
    r(x, y, width, 19, "#373345");
    r(x + 9, y + 8, 4, 4, "#db9b94");
    r(x + 17, y + 8, 4, 4, "#e0c18c");
    r(x + 25, y + 8, 4, 4, "#adc397");
    text("TEAM BOARD", x + width / 2, y + 6, "#ccc4d4", 8, "center");
    r(x, y + 19, 82, height - 19, "#302d40");
    text("mesh office", x + 9, y + 31, "#ded1e8", 9);
    r(x + 4, y + 49, 74, 15, "#595069");
    text("# global", x + 10, y + 52, "#ede7f2", 8);
    text("TEAM", x + 10, y + 78, "#8f849f", 7);
    const members = snapshot.run?.members || [];
    for (let i = 0; i < Math.min(members.length, 4); i++) {
      r(x + 10, y + 93 + i * 12, 4, 4, agentColors[i]);
      text(members[i].name, x + 21, y + 91 + i * 12, "#aaa0ba", 7);
    }
    text("# Global Chat", x + 94, y + 29, "#ede5f0", 10);
    r(x + 83, y + 47, 269, 1, "#41414f");
    const messages = (snapshot.messages || [])
      .filter((message) => message.channel === "global")
      .slice(-3);
    if (!messages.length) {
      text("Your team's conversations go here.", x + 99, y + 70, "#a9a2b7", 8);
      text(
        "Shared ideas, questions, and results.",
        x + 99,
        y + 86,
        "#77758d",
        7,
      );
      text("OPEN THE BOARD  ↗", x + 99, y + 122, "#c3dea1", 8);
    } else
      messages.forEach((message, index) => {
        const yy = y + 58 + index * 29;
        const n = Math.max(0, Number(message.from.split("-")[1]) - 1);
        r(
          x + 95,
          yy,
          13,
          13,
          message.from === "human"
            ? "#c9ef9b"
            : agentColors[n % agentColors.length],
        );
        text(
          message.from === "human" ? "You" : message.from,
          x + 117,
          yy - 1,
          "#dbd2e6",
          8,
        );
        text(
          clipped(message.text.replace(/\s+/g, " "), 36),
          x + 117,
          yy + 11,
          "#a49eb2",
          7,
        );
      });
    r(x + width - 3, y + height - 3, 3, 3, "#f1dcbf");
  }

  function desk(position, index, member) {
    const { x, y, scale } = position;
    const active = member?.status === "working";
    const waiting = member?.status === "waiting";
    const color = agentColors[index % agentColors.length];
    c.save();
    c.translate(x, y);
    c.scale(scale, scale);
    r(-56, 22, 117, 39, "#8a6c7540");
    r(-48, 27, 8, 30, "#716577");
    r(40, 27, 8, 30, "#716577");
    r(-54, 2, 108, 36, "#977c76");
    r(-54, 0, 108, 30, "#e2bc96");
    r(-50, 3, 100, 23, "#e7c5a5");
    r(-54, 30, 108, 5, "#bb927d");
    // Monitor, keyboard and mug.
    r(-23, -24, 48, 34, "#514e64");
    r(-20, -21, 42, 27, member ? "#304d58" : "#63667a");
    if (member) {
      const bright = active && frame % 4 < 2;
      for (let i = 0; i < 4; i++)
        r(
          -16,
          -17 + i * 5,
          12 + ((index * 7 + i * 3 + (bright ? 5 : 0)) % 21),
          2,
          i % 2 ? "#91b9b0" : "#c6c19e",
        );
      r(17, -17, 2, 16, "#597981");
    }
    r(-3, 10, 8, 5, "#6e677d");
    r(-12, 15, 27, 3, "#93879a");
    r(-20, 20, 37, 8, "#ada3ae");
    r(-17, 22, 30, 2, "#d6c6c5");
    r(23, 22, 7, 8, "#a196a3");
    r(37, 5, 10, 11, "#f1e1cc");
    r(47, 8, 3, 6, "#e9d6c0");
    r(39, 6, 6, 3, "#7c635e");
    r(-44, 6, 12, 16, "#b5c5b4");
    r(-41, 9, 6, 1, "#789784");
    r(-41, 13, 7, 1, "#789784");
    // Chair faces the screen, with the seated character in front.
    r(-14, 44, 30, 20, "#535369");
    r(-17, 48, 36, 10, "#5f5e77");
    r(-11, 44, 24, 16, "#77748c");
    r(-3, 63, 8, 6, "#5a5268");
    r(-14, 69, 30, 3, "#60536a");
    if (member) {
      const skin = ["#dfb293", "#c28f78", "#edc7a4", "#bc8a72"][index % 4];
      const hair = ["#564652", "#755749", "#303c4d", "#a87955", "#6b567a"][
        index % 5
      ];
      const move = active && !reduceMotion ? frame % 2 : 0;
      r(-8, 48, 8, 14, "#454458");
      r(3, 48, 8, 14, "#454458");
      r(-10, 59, 10, 4, "#383849");
      r(3, 59, 11, 4, "#383849");
      r(-12, 31, 27, 23, color);
      r(-14, 36, 5, 14, color);
      r(12, 36, 5, 14, color);
      r(-9, 47, 21, 7, "#00000010");
      r(-16, 27 - move, 6, 12, skin);
      r(13, 28 + move, 6, 11, skin);
      r(-8, 14, 20, 19, skin);
      r(-11, 12, 26, 14, hair);
      r(-9, 8, 22, 7, hair);
      r(-11, 21, 6, 8, hair);
      r(9, 19, 6, 10, hair);
      r(-5, 10, 9, 3, "#ffffff15");
      if (waiting) text("· · ·", 23, 33, "#75637e", 10);
      if (member.status === "error") {
        r(26, 27, 14, 17, "#b65e70");
        text("!", 33, 30, "#ffe7cf", 12, "center");
      }
      // A brief envelope appears only after an actual outgoing message.
      const last = (snapshot.messages || []).findLast(
        (message) => message.from === member.name,
      );
      if (last && Date.now() - Date.parse(last.timestamp) < 6500) {
        const offset = reduceMotion ? 0 : frame % 3;
        r(20, -19 - offset, 23, 16, "#edf0d0");
        r(22, -17 - offset, 19, 12, "#f7f2dc");
        line(22, -17 - offset, 31, -11 - offset, "#9b9c8d");
        line(41, -17 - offset, 31, -11 - offset, "#9b9c8d");
      }
      const statusColor = active
        ? "#cbebad"
        : member.status === "error"
          ? "#f4b3ad"
          : "#e4d7db";
      const statusText = ["error", "stopped", "starting"].includes(
        member.status,
      )
        ? statusNames[member.status]
        : member.statusMessage || statusNames[member.status] || "Waiting";
      r(-62, -55, 124, 20, "#54475fdd");
      r(-60, -57, 120, 20, "#f0ded1");
      r(-3, -37, 6, 4, "#f0ded1");
      r(
        -54,
        -50,
        5,
        5,
        active ? "#719866" : member.status === "error" ? "#bf6573" : "#a59aaa",
      );
      text(clipped(statusText, 17), -44, -51, "#64516b", 8);
      r(-34, 78, 68, 15, "#705d78dd");
      text(member.name, 0, 81, statusColor, 9, "center");
    } else {
      text("available desk", 0, 80, "#8b6e77", 8, "center");
    }
    c.restore();
  }

  function draw(time) {
    if (time - lastDraw > 120) {
      lastDraw = time;
      if (!reduceMotion) frame++;
      c.clearRect(0, 0, 960, 620);
      background();
      board();
      const members = snapshot.run?.members || [];
      const positions = deskPositions(members.length || 10);
      positions.forEach((position, index) =>
        desk(position, index, members[index]),
      );
      // The edge gives the room a small, tangible diorama feel.
      r(0, 0, 7, 620, "#514c6566");
      r(953, 0, 7, 620, "#514c6566");
    }
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
  return {
    update(value) {
      snapshot = value;
    },
  };
}
