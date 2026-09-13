/* ============================================================
   农历(阴历) ↔ 公历(阳历) 转换
   ------------------------------------------------------------
   算法与数据表摘录自开源项目:
   isee15/Lunar-Solar-Calendar-Converter (MIT License)
   https://github.com/isee15/Lunar-Solar-Calendar-Converter
   另参考 6tail/lunar-javascript (MIT License)
   https://github.com/6tail/lunar-javascript

   支持范围: 公历/农历 1887-2100
   本文件零依赖, 可离线运行。
   ============================================================ */

(function () {
  "use strict";

  /* 每年农历数据(首元素 1887 = 起始年份):
     低 13 位: 1-12 月大小(1=30天 0=29天, bit12 对应正月)
     第 13-16 位: 闰月月份(0=无闰月) */
  const lunar_month_days = [
    1887, 0x1694, 0x16aa, 0x4ad5,
    0xab6, 0xc4b7, 0x4ae, 0xa56, 0xb52a, 0x1d2a, 0xd54, 0x75aa, 0x156a,
    0x1096d, 0x95c, 0x14ae, 0xaa4d, 0x1a4c, 0x1b2a, 0x8d55, 0xad4,
    0x135a, 0x495d, 0x95c, 0xd49b, 0x149a, 0x1a4a, 0xbaa5, 0x16a8,
    0x1ad4, 0x52da, 0x12b6, 0xe937, 0x92e, 0x1496, 0xb64b, 0xd4a,
    0xda8, 0x95b5, 0x56c, 0x12ae, 0x492f, 0x92e, 0xcc96, 0x1a94,
    0x1d4a, 0xada9, 0xb5a, 0x56c, 0x726e, 0x125c, 0xf92d, 0x192a,
    0x1a94, 0xdb4a, 0x16aa, 0xad4, 0x955b, 0x4ba, 0x125a, 0x592b,
    0x152a, 0xf695, 0xd94, 0x16aa, 0xaab5, 0x9b4, 0x14b6, 0x6a57,
    0xa56, 0x1152a, 0x1d2a, 0xd54, 0xd5aa, 0x156a, 0x96c, 0x94ae,
    0x14ae, 0xa4c, 0x7d26, 0x1b2a, 0xeb55, 0xad4, 0x12da, 0xa95d,
    0x95a, 0x149a, 0x9a4d, 0x1a4a, 0x11aa5, 0x16a8, 0x16d4, 0xd2da,
    0x12b6, 0x936, 0x9497, 0x1496, 0x1564b, 0xd4a, 0xda8, 0xd5b4,
    0x156c, 0x12ae, 0xa92f, 0x92e, 0xc96, 0x6d4a, 0x1d4a, 0x10d65,
    0xb58, 0x156c, 0xb26d, 0x125c, 0x192c, 0x9a95, 0x1a94, 0x1b4a,
    0x4b55, 0xad4, 0xf55b, 0x4ba, 0x125a, 0xb92b, 0x152a, 0x1694,
    0x96aa, 0x15aa, 0x12ab5, 0x974, 0x14b6, 0xca57, 0xa56, 0x1526,
    0x8e95, 0xd54, 0x15aa, 0x49b5, 0x96c, 0xd4ae, 0x149c, 0x1a4c,
    0xbd26, 0x1aa6, 0xb54, 0x6d6a, 0x12da, 0x1695d, 0x95a, 0x149a,
    0xda4b, 0x1a4a, 0x1aa4, 0xbb54, 0x16b4, 0xada, 0x495b, 0x936,
    0xf497, 0x1496, 0x154a, 0xb6a5, 0xda4, 0x15b4, 0x6ab6, 0x126e,
    0x1092f, 0x92e, 0xc96, 0xcd4a, 0x1d4a, 0xd64, 0x956c, 0x155c,
    0x125c, 0x792e, 0x192c, 0xfa95, 0x1a94, 0x1b4a, 0xab55, 0xad4,
    0x14da, 0x8a5d, 0xa5a, 0x1152b, 0x152a, 0x1694, 0xd6aa, 0x15aa,
    0xab4, 0x94ba, 0x14b6, 0xa56, 0x7527, 0xd26, 0xee53, 0xd54, 0x15aa,
    0xa9b5, 0x96c, 0x14ae, 0x8a4e, 0x1a4c, 0x11d26, 0x1aa4, 0x1b54,
    0xcd6a, 0xada, 0x95c, 0x949d, 0x149a, 0x1a2a, 0x5b25, 0x1aa4,
    0xfb52, 0x16b4, 0xaba, 0xa95b, 0x936, 0x1496, 0x9a4b, 0x154a,
    0x136a5, 0xda4, 0x15ac
  ];

  /* 每年农历正月初一对应的公历日期(首元素 1887 = 起始年份):
     高 12 位: 公历年, 中 4 位: 公历月, 低 5 位: 公历日 */
  const solar_1_1 = [
    1887, 0xec04c, 0xec23f, 0xec435, 0xec649,
    0xec83e, 0xeca51, 0xecc46, 0xece3a, 0xed04d, 0xed242, 0xed436,
    0xed64a, 0xed83f, 0xeda53, 0xedc48, 0xede3d, 0xee050, 0xee244,
    0xee439, 0xee64d, 0xee842, 0xeea36, 0xeec4a, 0xeee3e, 0xef052,
    0xef246, 0xef43a, 0xef64e, 0xef843, 0xefa37, 0xefc4b, 0xefe41,
    0xf0054, 0xf0248, 0xf043c, 0xf0650, 0xf0845, 0xf0a38, 0xf0c4d,
    0xf0e42, 0xf1037, 0xf124a, 0xf143e, 0xf1651, 0xf1846, 0xf1a3a,
    0xf1c4e, 0xf1e44, 0xf2038, 0xf224b, 0xf243f, 0xf2653, 0xf2848,
    0xf2a3b, 0xf2c4f, 0xf2e45, 0xf3039, 0xf324d, 0xf3442, 0xf3636,
    0xf384a, 0xf3a3d, 0xf3c51, 0xf3e46, 0xf403b, 0xf424e, 0xf4443,
    0xf4638, 0xf484c, 0xf4a3f, 0xf4c52, 0xf4e48, 0xf503c, 0xf524f,
    0xf5445, 0xf5639, 0xf584d, 0xf5a42, 0xf5c35, 0xf5e49, 0xf603e,
    0xf6251, 0xf6446, 0xf663b, 0xf684f, 0xf6a43, 0xf6c37, 0xf6e4b,
    0xf703f, 0xf7252, 0xf7447, 0xf763c, 0xf7850, 0xf7a45, 0xf7c39,
    0xf7e4d, 0xf8042, 0xf8254, 0xf8449, 0xf863d, 0xf8851, 0xf8a46,
    0xf8c3b, 0xf8e4f, 0xf9044, 0xf9237, 0xf944a, 0xf963f, 0xf9853,
    0xf9a47, 0xf9c3c, 0xf9e50, 0xfa045, 0xfa238, 0xfa44c, 0xfa641,
    0xfa836, 0xfaa49, 0xfac3d, 0xfae52, 0xfb047, 0xfb23a, 0xfb44e,
    0xfb643, 0xfb837, 0xfba4a, 0xfbc3f, 0xfbe53, 0xfc048, 0xfc23c,
    0xfc450, 0xfc645, 0xfc839, 0xfca4c, 0xfcc41, 0xfce36, 0xfd04a,
    0xfd23d, 0xfd451, 0xfd646, 0xfd83a, 0xfda4d, 0xfdc43, 0xfde37,
    0xfe04b, 0xfe23f, 0xfe453, 0xfe648, 0xfe83c, 0xfea4f, 0xfec44,
    0xfee38, 0xff04c, 0xff241, 0xff436, 0xff64a, 0xff83e, 0xffa51,
    0xffc46, 0xffe3a, 0x10004e, 0x100242, 0x100437, 0x10064b, 0x100841,
    0x100a53, 0x100c48, 0x100e3c, 0x10104f, 0x101244, 0x101438,
    0x10164c, 0x101842, 0x101a35, 0x101c49, 0x101e3d, 0x102051,
    0x102245, 0x10243a, 0x10264e, 0x102843, 0x102a37, 0x102c4b,
    0x102e3f, 0x103053, 0x103247, 0x10343b, 0x10364f, 0x103845,
    0x103a38, 0x103c4c, 0x103e42, 0x104036, 0x104249, 0x10443d,
    0x104651, 0x104846, 0x104a3a, 0x104c4e, 0x104e43, 0x105038,
    0x10524a, 0x10543e, 0x105652, 0x105847, 0x105a3b, 0x105c4f,
    0x105e45, 0x106039, 0x10624c, 0x106441, 0x106635, 0x106849,
    0x106a3d, 0x106c51, 0x106e47, 0x10703c, 0x10724f, 0x107444,
    0x107638, 0x10784c, 0x107a3f, 0x107c53, 0x107e48
  ];

  function getBitInt(data, length, shift) {
    return (data & (((1 << length) - 1) << shift)) >> shift;
  }

  /* 公历日期 → 天数序号(1582年10月前的日期不准确, 本库范围不受影响) */
  function solarToInt(y, m, d) {
    m = (m + 9) % 12;
    y = parseInt(y) - parseInt(m / 10);
    return 365 * y + parseInt(y / 4) - parseInt(y / 100) + parseInt(y / 400)
      + parseInt((m * 306 + 5) / 10) + (d - 1);
  }

  /* 天数序号 → 公历日期 */
  function solarFromInt(g) {
    let y = parseInt((10000 * g + 14780) / 3652425);
    let ddd = g - (365 * y + parseInt(y / 4) - parseInt(y / 100) + parseInt(y / 400));
    if (ddd < 0) {
      y--;
      ddd = g - (365 * y + parseInt(y / 4) - parseInt(y / 100) + parseInt(y / 400));
    }
    const mi = parseInt((100 * ddd + 52) / 3060);
    const mm = (mi + 2) % 12 + 1;
    y = y + parseInt((mi + 2) / 12);
    const dd = ddd - parseInt((mi * 306 + 5) / 10) + 1;
    return { year: parseInt(y), month: parseInt(mm), day: parseInt(dd) };
  }

  /* ---------- 对外接口 ---------- */

  /** 该农历年的闰月月份(0 = 无闰月) */
  function leapMonth(lunarYear) {
    if (lunarYear < 1887 || lunarYear > 2100) return 0;
    return getBitInt(lunar_month_days[lunarYear - 1887], 4, 13);
  }

  /** 某农历月实际有多少天(29/30)；该年没有这个月(如闰月不存在)时返回 0。
      用于把"三十"夹到只有 29 天的月份，避免换算成下月初一 */
  function monthDays(lunarYear, lunarMonth, isLeap) {
    if (lunarYear < 1887 || lunarYear > 2100) return 0;
    if (lunarMonth < 1 || lunarMonth > 12) return 0;
    const days = lunar_month_days[lunarYear - 1887];
    const leap = getBitInt(days, 4, 13);
    let idx;
    if (isLeap) {
      if (leap !== lunarMonth) return 0;
      idx = leap;                                  // 闰月插在第 leap 个正月份之后
    } else {
      idx = lunarMonth - 1;
      if (leap !== 0 && lunarMonth > leap) idx = lunarMonth;
    }
    return getBitInt(days, 1, 12 - idx) === 1 ? 30 : 29;
  }

  /** 农历 → 公历。isLeap 表示该月是否为闰月。
      返回 { year, month, day } 或 null(超出数据范围/该年无此闰月) */
  function toSolar(lunarYear, lunarMonth, lunarDay, isLeap) {
    if (lunarYear < 1887 || lunarYear > 2100) return null;
    const days = lunar_month_days[lunarYear - 1887];
    const leap = getBitInt(days, 4, 13);
    if (isLeap && leap === 0) return null; // 该年无闰月
    if (lunarMonth < 1 || lunarMonth > 12) return null;
    if (lunarDay < 1 || lunarDay > 30) return null;

    let offset = 0;
    let loopend;
    if (isLeap) {
      loopend = leap; // 闰月前面正好是 leap 个正月份
    } else if (lunarMonth <= leap || leap === 0) {
      loopend = lunarMonth - 1;
    } else {
      loopend = lunarMonth;
    }
    for (let i = 0; i < loopend; i++) {
      offset += getBitInt(days, 1, 12 - i) === 1 ? 30 : 29;
    }
    offset += lunarDay;

    const solar11 = solar_1_1[lunarYear - 1887];
    const y = getBitInt(solar11, 12, 9);
    const m = getBitInt(solar11, 4, 5);
    const d = getBitInt(solar11, 5, 0);
    return solarFromInt(solarToInt(y, m, d) + offset - 1);
  }

  /** 公历 → 农历。返回 { year, month, day, isLeap } 或 null */
  function toLunar(solarYear, solarMonth, solarDay) {
    if (solarYear < 1887 || solarYear > 2100) return null;
    let index = solarYear - 1887;
    const data = (solarYear << 9) | (solarMonth << 5) | solarDay;
    if (solar_1_1[index] > data) index--;
    const solar11 = solar_1_1[index];
    const y = getBitInt(solar11, 12, 9);
    const m = getBitInt(solar11, 4, 5);
    const d = getBitInt(solar11, 5, 0);
    let offset = solarToInt(solarYear, solarMonth, solarDay) - solarToInt(y, m, d);

    const days = lunar_month_days[index];
    const leap = getBitInt(days, 4, 13);

    const lunarYear = index + 1887;
    let lunarMonth = 1;
    offset += 1;

    for (let i = 0; i < 13; i++) {
      const dm = getBitInt(days, 1, 12 - i) === 1 ? 30 : 29;
      if (offset > dm) {
        lunarMonth++;
        offset -= dm;
      } else {
        break;
      }
    }
    const lunarDay = parseInt(offset);
    let isLeap = false;
    if (leap !== 0 && lunarMonth > leap) {
      lunarMonth = lunarMonth - 1;
      if (lunarMonth === leap) isLeap = true;
    }
    return { year: lunarYear, month: lunarMonth, day: lunarDay, isLeap };
  }

  /* ---------- 中文显示 ---------- */

  const CN_NUM = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十"];
  const CN_MONTH = ["正", "二", "三", "四", "五", "六", "七", "八", "九", "十", "冬", "腊"];

  /** 农历月日的中文写法, 如 "八月十五"、"闰四月初八"、"腊月三十" */
  function dateCN(lunarMonth, lunarDay, isLeap) {
    return monthCN(lunarMonth, isLeap) + dayCN(lunarDay);
  }

  /** 农历月的中文写法, 如 "六月"、"闰六月"、"腊月" */
  function monthCN(lunarMonth, isLeap) {
    return (isLeap ? "闰" : "") + CN_MONTH[lunarMonth - 1] + "月";
  }

  /** 农历日的中文写法, 如 "十五"、"初八"、"三十" */
  function dayCN(lunarDay) {
    if (lunarDay === 10) return "初十";
    if (lunarDay < 10) return "初" + CN_NUM[lunarDay];
    if (lunarDay < 20) return "十" + CN_NUM[lunarDay - 10];
    if (lunarDay === 20) return "二十";
    if (lunarDay < 30) return "廿" + CN_NUM[lunarDay - 20];
    return "三十";
  }

  window.Lunar = {
    toSolar: toSolar,
    toLunar: toLunar,
    leapMonth: leapMonth,
    monthDays: monthDays,
    dateCN: dateCN,
    monthCN: monthCN,
    dayCN: dayCN,
  };
})();
