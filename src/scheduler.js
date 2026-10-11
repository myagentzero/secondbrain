const cron = require('node-cron');
const { runDailyDigest } = require('./digests/daily');
const { runWeeklyDigest } = require('./digests/weekly');
const { runDailyMaintenance, runWeeklyOrphanCleanup } = require('./digests/maintenance');
const { runCalendarSync } = require('./calendar/sync');

let dailyJob = null;
let weeklyJob = null;
let maintenanceJob = null;
let maintenanceAfternoonJob = null;
let calSyncHourlyJob = null;
let calSyncMonThuJob = null;
let calSyncFridayJob = null;

const startScheduler = () => {
  // Daily digest at 5:00 AM Phoenix time, weekdays only (Mon-Fri)
  dailyJob = cron.schedule('0 5 * * 1-5', async () => {
    console.log('Running scheduled daily digest...');
    try {
      await runDailyDigest();
    } catch (error) {
      console.error('Daily digest failed:', error);
    }
  }, {
    timezone: 'America/Phoenix'
  });



  const maintenanceTask = async () => {
    console.log('Running scheduled daily maintenance...');
    try {
      await runDailyMaintenance();
    } catch (error) {
      console.error('Daily maintenance failed:', error);
    }
  };

  // Daily maintenance at 4:30 AM Phoenix time, every day
  maintenanceJob = cron.schedule('30 4 * * *', maintenanceTask, {
    timezone: 'America/Phoenix'
  });

  // ...and again at 12:05 PM and 4:05 PM on weekdays, so items finished during the day close the same day
  // (offset 5 minutes to avoid starting alongside the calendar sync)
  maintenanceAfternoonJob = cron.schedule('5 12,16 * * 1-5', maintenanceTask, {
    timezone: 'America/Phoenix'
  });

  // Weekly orphan cleanup + digest at 8:00 PM on Sunday
  weeklyJob = cron.schedule('0 20 * * 0', async () => {
    console.log('Running scheduled weekly orphan cleanup and digest...');
    // Independent try blocks so a cleanup failure can't skip the digest
    try {
      await runWeeklyOrphanCleanup();
    } catch (error) {
      console.error('Weekly orphan cleanup failed:', error);
    }
    try {
      console.log('Running scheduled weekly digest...');
      await runWeeklyDigest();
    } catch (error) {
      console.error('Weekly digest failed:', error);
    }
  }, {
    timezone: 'America/Phoenix'
  });

  // Calendar sync: weekdays 7am-3pm hourly, 1 day ahead
  calSyncHourlyJob = cron.schedule('0 7-15 * * 1-5', async () => {
    console.log('Running scheduled calendar sync (1 day)...');
    try {
      await runCalendarSync(1);
    } catch (error) {
      console.error('Calendar sync failed:', error);
    }
  }, {
    timezone: 'America/Phoenix'
  });

  // Calendar sync: Mon-Thu 4pm, 2 days ahead
  calSyncMonThuJob = cron.schedule('0 16 * * 1-4', async () => {
    console.log('Running scheduled calendar sync (2 days)...');
    try {
      await runCalendarSync(2);
    } catch (error) {
      console.error('Calendar sync failed:', error);
    }
  }, {
    timezone: 'America/Phoenix'
  });

  // Calendar sync: Friday 4pm, 4 days ahead (covers weekend)
  calSyncFridayJob = cron.schedule('0 16 * * 5', async () => {
    console.log('Running scheduled calendar sync (4 days)...');
    try {
      await runCalendarSync(4);
    } catch (error) {
      console.error('Calendar sync failed:', error);
    }
  }, {
    timezone: 'America/Phoenix'
  });

  console.log('Scheduler started:');
  console.log('  - Daily maintenance: 4:30 AM (Every day), 12:05 PM and 4:05 PM (Mon-Fri)');
  console.log('  - Daily digest: 5:00 AM (Mon-Fri)');
  console.log('  - Weekly orphan cleanup + digest: Sunday 8:00 PM');
  console.log('  - Calendar sync: Weekdays 7am-3pm hourly (1 day ahead)');
  console.log('  - Calendar sync: Mon-Thu 4pm (2 days ahead)');
  console.log('  - Calendar sync: Friday 4pm (4 days ahead)');
};

const stopScheduler = () => {
  if (dailyJob) {
    dailyJob.stop();
    dailyJob = null;
  }
  if (weeklyJob) {
    weeklyJob.stop();
    weeklyJob = null;
  }
  if (maintenanceJob) {
    maintenanceJob.stop();
    maintenanceJob = null;
  }
  if (maintenanceAfternoonJob) {
    maintenanceAfternoonJob.stop();
    maintenanceAfternoonJob = null;
  }
  if (calSyncHourlyJob) {
    calSyncHourlyJob.stop();
    calSyncHourlyJob = null;
  }
  if (calSyncMonThuJob) {
    calSyncMonThuJob.stop();
    calSyncMonThuJob = null;
  }
  if (calSyncFridayJob) {
    calSyncFridayJob.stop();
    calSyncFridayJob = null;
  }
  console.log('Scheduler stopped');
};

module.exports = {
  startScheduler,
  stopScheduler
};
