// Utility functions for dates

/**
 * Safely parse Date or YYYY-MM-DD string to local Date object at noon (12:00)
 * Completely immune to UTC midnight shifts and Daylight Saving rollovers.
 */
export const parseLocalDateObject = (refDate) => {
  if (!refDate) return new Date();
  if (refDate instanceof Date) return new Date(refDate.getTime());
  const str = String(refDate).trim().split('T')[0];
  const parts = str.split('-');
  if (parts.length === 3) {
    const y = parseInt(parts[0], 10);
    const m = parseInt(parts[1], 10) - 1;
    const d = parseInt(parts[2], 10);
    return new Date(y, m, d, 12, 0, 0);
  }
  return new Date(refDate);
};

export const getTodayDateStr = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Dynamic 5-Day Working Week Calculator:
 * - Saturday (day 6) -> Friday (T-1)
 * - Sunday (day 0)   -> Friday (T-2)
 * - Monday (day 1)   -> Friday (T-3) [e.g. 12 Oct falls back to 09 Oct]
 * - Tuesday (day 2)  -> Monday (T-1) [e.g. 13 Oct falls back to 12 Oct]
 * - Wednesday (day 3)-> Tuesday (T-1)
 * - Thursday (day 4) -> Wednesday (T-1)
 * - Friday (day 5)   -> Thursday (T-1)
 */
export const getPreviousWorkdayDateStr = (refDate = new Date()) => {
  const d = parseLocalDateObject(refDate);
  const day = d.getDay(); // 0 is Sunday, 6 is Saturday

  let daysToSubtract = 1;
  if (day === 0) {
    // Sunday -> Friday
    daysToSubtract = 2;
  } else if (day === 1) {
    // Monday -> Friday
    daysToSubtract = 3;
  } else if (day === 6) {
    // Saturday -> Friday
    daysToSubtract = 1;
  } else {
    // Tuesday, Wednesday, Thursday, Friday -> yesterday (T-1)
    daysToSubtract = 1;
  }

  d.setDate(d.getDate() - daysToSubtract);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

/**
 * Returns dynamic metadata and user-facing labels for the working date.
 * E.g. "Friday • Last Working Day" on weekends/Mondays, "Monday • Yesterday" on Tuesdays.
 */
export const getWorkdayInfo = (refDate = new Date()) => {
  const targetDateStr = getPreviousWorkdayDateStr(refDate);
  const targetObj = parseLocalDateObject(targetDateStr);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const targetDayName = dayNames[targetObj.getDay()];

  const refObj = parseLocalDateObject(refDate);
  const refDay = refObj.getDay();
  const isWeekendOrMonday = refDay === 0 || refDay === 1 || refDay === 6;

  const label = isWeekendOrMonday
    ? `${targetDayName} • Last Working Day`
    : `${targetDayName} • Yesterday`;

  const shortLabel = isWeekendOrMonday
    ? 'Last Working Day'
    : 'Yesterday';

  return {
    dateStr: targetDateStr,
    dayName: targetDayName,
    label,
    shortLabel,
    isWeekendOrMonday,
    displayString: `${targetDateStr} (${label})`,
  };
};

export const getWorkdayLabel = (refDate = new Date()) => {
  return getWorkdayInfo(refDate).label;
};

export const getYesterdayDateStr = (refDate = new Date()) => getPreviousWorkdayDateStr(refDate);
