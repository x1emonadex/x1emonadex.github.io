/* ============================================================
   pixel-video.js — видео, превращённое в пиксель-арт на лету.

   Что делает: берёт обычный .mp4, каждый кадр уменьшает до сетки
   «крупных пикселей» и рисует её на canvas. Края объекта получают
   цвет, который переливается при движении: тёплая гамма (жёлтый →
   оранжевый → красный) и синие всплески там, где объект движется.

   Подключение:

     <div class="pixel-video" data-pixel-video="assets/hero.mp4"></div>
     <script src="assets/pixel-video.js"></script>

   Или из кода:

     PixelVideo.mount(document.querySelector('.hero-art'), {
       src: 'assets/hero.mp4',
       pixelSize: 8
     });

   Все элементы создаются внутри переданного блока, поэтому вставлять
   можно в любой существующий div. Блок получает класс .pixel-video.
   ============================================================ */

(function (global) {
  'use strict';

  var DEFAULTS = {
    src: '',                // путь к .mp4
    pixelSize: 8,           // размер ячейки сетки на экране, px
    lowCut: 26,             // яркость, ниже которой квадрат минимальный
    highCut: 168,           // яркость, при которой квадрат занимает всю ячейку
    minScale: 0.1,          // минимальный размер квадрата (доля ячейки)
    gamma: 2.2,             // кривая роста: середина рассыпается в точки, яркое сливается
    edgeDelta: 46,          // перепад яркости, при котором пиксель считается краем
    speed: 0.7,             // скорость переливания цветов
    coreBoost: 1.14,        // осветление тела
    levels: 7,              // ступеней квантования цвета (0 — выключено)
    /* цветные пиксели: бегут по контуру объекта */
    palette: ['#8b1a1a', '#e60000', '#ff8c00', '#ffd700'],   // слои контура: от края внутрь
    ringNavy: '#1b2f8a',    // редкие синие вкрапления по самому краю
    ringChance: 0.09,
    rings: 4,               // сколько слоёв красить
    glyphs: true,           // редкие символы в тёмных зонах
    glyphSet: '01+*#%',
    glyphShare: 0.09,       // доля тёмных ячеек с символом
    dust: true,             // редкая «пыль» на фоне
    cover: true             // заполнять блок с обрезкой, как object-fit: cover
  };

  function hash01(x, y, frame) {
    var h = ((x * 73856093) ^ (y * 19349663) ^ (frame * 83492791)) >>> 0;
    h = (h ^ (h >>> 13)) >>> 0;
    return (h % 997) / 997;
  }

  function paletteAt(value, opt) {
    var p = opt.palette;
    if (!p || !p.length) return '#ffffff';
    var i = Math.floor(value) % p.length;
    if (i < 0) i += p.length;
    return p[i];
  }

  function hsvToRgb(h, s, v) {
    h = ((h % 1) + 1) % 1;
    var i = Math.floor(h * 6);
    var f = h * 6 - i;
    var p = v * (1 - s);
    var q = v * (1 - f * s);
    var t = v * (1 - (1 - f) * s);
    var r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      default: r = v; g = p; b = q;
    }
    return 'rgb(' + (r * 255 | 0) + ',' + (g * 255 | 0) + ',' + (b * 255 | 0) + ')';
  }

  function quantize(value, levels) {
    if (!levels || levels < 2) return value | 0;
    var step = 255 / (levels - 1);
    return Math.round(Math.round(value / step) * step) | 0;
  }

  function PixelVideo(container, options) {
    this.el = container;
    this.opt = {};
    for (var k in DEFAULTS) if (DEFAULTS.hasOwnProperty(k)) this.opt[k] = DEFAULTS[k];
    for (var j in options) if (options.hasOwnProperty(j)) this.opt[j] = options[j];

    this.frame = 0;
    this.prev = null;
    this._build();
  }

  PixelVideo.prototype._build = function () {
    var self = this;
    var opt = this.opt;

    var canvas = document.createElement('canvas');
    canvas.className = 'pixel-video__canvas';
    canvas.setAttribute('aria-hidden', 'true');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');

    var video = document.createElement('video');
    video.className = 'pixel-video__source';
    video.muted = true;
    video.defaultMuted = true;
    video.loop = true;
    video.autoplay = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.setAttribute('aria-hidden', 'true');
    video.preload = 'auto';
    if (opt.src) video.src = opt.src;
    this.video = video;

    this.el.classList.add('pixel-video');
    this.el.appendChild(video);
    this.el.appendChild(canvas);

    this.sample = document.createElement('canvas');
    this.sampleCtx = this.sample.getContext('2d', { willReadFrequently: true });

    this.reduceMotion = !!(global.matchMedia &&
      global.matchMedia('(prefers-reduced-motion: reduce)').matches);

    this._raf = global.requestAnimationFrame
      ? global.requestAnimationFrame.bind(global)
      : function (cb) { return setTimeout(cb, 16); };

    video.addEventListener('loadedmetadata', function () { self._fit(); });
    video.addEventListener('ended', function () {
      try { video.play(); } catch (e) {}
    });
    video.addEventListener('canplay', function () {
      self._fit();
      var playing = video.play();
      if (playing && playing.catch) playing.catch(function () {});
    });

    this._onResize = function () { self._fit(); };
    global.addEventListener('resize', this._onResize);

    this._fit();

    if (!this.reduceMotion) {
      /* Основной цикл — requestAnimationFrame. Рисуем, когда видео ушло
         на новый кадр. Если время залипло (стык цикла, где currentTime
         замирает на нуле), перезапускаем ролик сами. */
      var stuck = 0;
      var loop = function () {
        var advanced = video.currentTime !== self._lastTime;
        if (self.frame === 0 || advanced) {
          self.draw();
          stuck = 0;
        } else if (!video.paused && video.readyState >= 2) {
          stuck++;
          if (stuck === 45) {
            stuck = 0;
            try { video.currentTime = 0.05; video.play(); } catch (e) {}
          }
        }
        self._raf(loop);
      };
      this._raf(loop);
    } else {
      // при отключённой анимации показываем один кадр
      var once = function () {
        if (video.readyState >= 2) self.draw();
        else self._raf(once);
      };
      this._raf(once);
    }

    /* Страховка: если кадры не приходят (фоновая вкладка, окно без
       отрисовки, headless), дорисовываем по таймеру. */
    this._lastDraw = 0;
    this._watchdog = global.setInterval(function () {
      if (!self.video || !self.canvas) return;
      var now = global.performance ? global.performance.now() : Date.now();
      if (now - self._lastDraw < 150) return;
      if (self.reduceMotion && self.frame > 0) return;
      if (self.video.readyState >= 2) self.draw();
    }, 100);
  };

  /* Пересчёт размеров: сетка пикселей и размер холста */
  PixelVideo.prototype._fit = function () {
    var el = this.el, video = this.video, opt = this.opt;
    var width = el.clientWidth || 360;
    var height = el.clientHeight;
    var vw = video.videoWidth || 1, vh = video.videoHeight || 1;

    if (!height || height < 40) height = Math.round(width * vh / vw);

    var dpr = Math.min(global.devicePixelRatio || 1, 2);

    this.dispW = width;
    this.dispH = height;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';

    this.cols = Math.max(2, Math.round(width / opt.pixelSize));
    this.rows = Math.max(2, Math.round(height / opt.pixelSize));
    this.sample.width = this.cols;
    this.sample.height = this.rows;
    this.cellW = this.canvas.width / this.cols;
    this.cellH = this.canvas.height / this.rows;

    this.lum = new Float32Array(this.cols * this.rows);
    this.mask = new Uint8Array(this.cols * this.rows);
    this.prev = null;
  };

  /* Один кадр: уменьшение видео до сетки, раскраска, отрисовка.
     Ошибки не должны убивать цикл: при сбое просто пропускаем кадр. */
  PixelVideo.prototype.draw = function () {
    try {
      this._drawFrame();
    } catch (e) {
      this._lastError = e;
      var text = String((e && e.name) || '') + ' ' + String((e && e.message) || '');
      if (/tainted|SecurityError|insecure/i.test(text)) {
        // страница открыта как file:// — холст помечен как чужие данные,
        // показываем обычное видео, чтобы блок не остался пустым
        this.el.classList.add('pixel-video--fallback');
      }
      if (!this._warned) {
        this._warned = true;
        if (global.console && global.console.warn) {
          global.console.warn('pixel-video: кадр не отрисован —', e && e.message);
        }
      }
      this._lastDraw = global.performance ? global.performance.now() : Date.now();
    }
  };

  PixelVideo.prototype._drawFrame = function () {
    var video = this.video, opt = this.opt;
    if (!video.videoWidth || video.readyState < 2) return;

    var cols = this.cols, rows = this.rows;
    var total = cols * rows;
    if (this.lum.length !== total) this._fit();

    // 1. кадр видео — в сетку размером cols x rows (браузер усредняет сам)
    var sw = video.videoWidth, sh = video.videoHeight;
    var sx = 0, sy = 0, scw = sw, sch = sh;

    if (opt.cover) {
      var targetAspect = cols / rows;
      var srcAspect = sw / sh;
      if (srcAspect > targetAspect) {
        scw = sh * targetAspect;
        sx = (sw - scw) / 2;
      } else {
        sch = sw / targetAspect;
        sy = (sh - sch) / 2;
      }
    }

    var sctx = this.sampleCtx;
    sctx.imageSmoothingEnabled = true;
    sctx.clearRect(0, 0, cols, rows);
    sctx.drawImage(video, sx, sy, scw, sch, 0, 0, cols, rows);

    var data = sctx.getImageData(0, 0, cols, rows).data;
    var lum = this.lum;

    for (var i = 0; i < total; i++) {
      lum[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    }

    // пустой кадр на стыке цикла не затирает картинку
    var totalLum = 0;
    for (var s = 0; s < total; s++) totalLum += lum[s];
    if (totalLum < total * 4) {
      if (video.ended || video.currentTime > video.duration - 0.15) {
        try { video.currentTime = 0.05; video.play(); } catch (e) {}
      }
      return;
    }

    /* 2. отрисовка «матрицей»: каждая ячейка сетки загорается квадратом,
       размер которого зависит от яркости кадра — яркое сливается в массу,
       тени и края рассыпаются в мелкие точки. Движение получается само:
       картинка не едет, меняются сами ячейки. */
    var ctx = this.ctx;
    var cellW = this.cellW;
    var cellH = this.cellH;
    var cellPx = Math.min(cellW, cellH);
    var time = this.frame / 60;
    var span = Math.max(1, opt.highCut - opt.lowCut);
    var glyphBudget = 60;

    // слои контура: расстояние каждой ячейки до фона (два прохода)
    var dist = this.dist;
    if (!dist || dist.length !== total) dist = this.dist = new Uint16Array(total);
    for (var i = 0; i < total; i++) dist[i] = (lum[i] > opt.lowCut) ? 65000 : 0;
    for (var ry = 0; ry < rows; ry++) {
      for (var rx = 0; rx < cols; rx++) {
        var rk = ry * cols + rx;
        if (dist[rk] === 0) continue;
        if (rx > 0 && dist[rk - 1] + 1 < dist[rk]) dist[rk] = dist[rk - 1] + 1;
        if (ry > 0 && dist[rk - cols] + 1 < dist[rk]) dist[rk] = dist[rk - cols] + 1;
      }
    }
    for (var ry2 = rows - 1; ry2 >= 0; ry2--) {
      for (var rx2 = cols - 1; rx2 >= 0; rx2--) {
        var rk2 = ry2 * cols + rx2;
        if (dist[rk2] === 0) continue;
        if (rx2 < cols - 1 && dist[rk2 + 1] + 1 < dist[rk2]) dist[rk2] = dist[rk2 + 1] + 1;
        if (ry2 < rows - 1 && dist[rk2 + cols] + 1 < dist[rk2]) dist[rk2] = dist[rk2 + cols] + 1;
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = Math.round(cellPx * 0.95) + 'px "JetBrains Mono", Consolas, monospace';

    /* Копим прямоугольники по цвету: смена fillStyle на каждую ячейку
       тормозит отрисовку, а так на весь кадр остаётся десяток заливок. */
    var batches = this._batches || (this._batches = {});
    for (var bk in batches) delete batches[bk];
    var colors = this._colors || (this._colors = {});
    var dustKey = 'rgba(140,160,170,0.35)';
    var push = function (color, rx, ry, rw, rh) {
      var arr = batches[color];
      if (arr === undefined) arr = batches[color] = [];
      arr.push(rx, ry, rw, rh);
    };

    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        var idx = y * cols + x;
        var level = lum[idx];
        var t = (level - opt.lowCut) / span;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);

        var px = x * cellW;
        var py = y * cellH;

        if (t <= 0.001) {
          // тёмная зона: редкие символы и «пыль»
          if (opt.glyphs && glyphBudget > 0 && level > opt.lowCut * 0.4 &&
              hash01(x, y, this.frame) < opt.glyphShare) {
            ctx.fillStyle = 'rgba(150,175,190,0.5)';
            ctx.fillText(opt.glyphSet.charAt((x * 3 + y * 5 + this.frame) % opt.glyphSet.length),
                         px + cellW / 2, py + cellH / 2);
            glyphBudget--;
          } else if (opt.dust && hash01(x, y, this.frame + 7) < 0.012) {
            push(dustKey, px + cellW * 0.4, py + cellH * 0.4, cellPx * 0.22, cellPx * 0.22);
          }
          continue;
        }

        // край: слои контура по расстоянию до фона — тёмно-красный,
        // красный, оранжевый, золотой; дальше обычный цвет кадра
        var layer = dist[idx];

        var scale = opt.minScale + (1 - opt.minScale) * Math.pow(t, opt.gamma);
        var side = cellPx * scale;
        var ox = px + (cellW - side) / 2;
        var oy = py + (cellH - side) / 2;

        if (layer <= opt.rings) {
          if (layer === 1 && hash01(x, y, 0) < opt.ringChance) {
            push(opt.ringNavy, ox, oy, side, side);
          } else {
            push(opt.palette[layer - 1], ox, oy, side, side);
          }
        } else {
          var qr = quantize(Math.min(255, data[idx * 4] * opt.coreBoost), opt.levels);
          var qg = quantize(Math.min(255, data[idx * 4 + 1] * opt.coreBoost), opt.levels);
          var qb = quantize(Math.min(255, data[idx * 4 + 2] * opt.coreBoost), opt.levels);
          var key = (qr << 16) | (qg << 8) | qb;
          var col = colors[key];
          if (col === undefined) col = colors[key] = 'rgb(' + qr + ',' + qg + ',' + qb + ')';
          push(col, ox, oy, side, side);
        }
      }
    }

    for (var ck in batches) {
      var rects = batches[ck];
      ctx.fillStyle = ck;
      ctx.beginPath();
      for (var ri = 0; ri < rects.length; ri += 4) {
        ctx.rect(rects[ri], rects[ri + 1], rects[ri + 2], rects[ri + 3]);
      }
      ctx.fill();
    }

    // 5. запоминаем яркость для определения движения на следующем кадре
    if (!this.prevBuf || this.prevBuf.length !== total) this.prevBuf = new Float32Array(total);
    this.prevBuf.set(lum);
    this.prev = this.prevBuf;
    this.frame++;
    this._lastTime = video.currentTime;
    this._lastDraw = global.performance ? global.performance.now() : Date.now();
  };

  /* Публичные методы */
  PixelVideo.prototype.setPixelSize = function (px) {
    this.opt.pixelSize = px;
    this._fit();
  };

  PixelVideo.prototype.destroy = function () {
    global.removeEventListener('resize', this._onResize);
    if (this._watchdog) global.clearInterval(this._watchdog);
    if (this.video) {
      try { this.video.pause(); } catch (e) {}
      this.video.removeAttribute('src');
      this.video.load();
    }
    this.el.innerHTML = '';
    this.el.classList.remove('pixel-video');
  };

  var PixelVideoNS = {
    defaults: DEFAULTS,
    PixelVideo: PixelVideo,
    mount: function (container, options) {
      if (!container) return null;
      return new PixelVideo(container, options || {});
    },
    /* Автозапуск: все блоки с атрибутом data-pixel-video */
    auto: function (root) {
      var scope = root || document;
      var nodes = scope.querySelectorAll('[data-pixel-video]');
      var started = [];
      for (var i = 0; i < nodes.length; i++) {
        started.push(new PixelVideo(nodes[i], { src: nodes[i].getAttribute('data-pixel-video') }));
      }
      return started;
    }
  };

  global.PixelVideo = PixelVideoNS;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { PixelVideoNS.auto(); });
  } else {
    PixelVideoNS.auto();
  }
})(window);
