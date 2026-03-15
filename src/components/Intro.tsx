"use client";

import styles from "./Intro.module.css";

interface IntroProps {
  onStart: () => void;
}

export default function Intro({ onStart }: IntroProps) {
  return (
    <div className={styles.wrapper}>
      <div className={styles.innerContainer}>
        <h1 className={styles.title}>wheredown.town</h1>
        <div className={styles.quote}>
          <div className={styles.quoteText}>
            We consider Downtown Manhattan to be everything south of 30th Street
          </div>
          <div>&mdash; StreetEasy</div>
        </div>
        <div className={styles.quote}>
          <div className={styles.quoteText}>
            Despite various definitions of Lower Manhattan, they generally
            include all of Manhattan Island south of 14th Street
          </div>
          <div>&mdash; Also Wikipedia</div>
        </div>
        <div className={styles.quote}>
          <div className={styles.quoteText}>
            I&apos;m thinking anything below Houston?
          </div>
          <div>&mdash; Reddit user</div>
        </div>
        <div className={styles.quote}>
          <div className={styles.quoteText}>Mainly anything south of Canal</div>
          <div>&mdash; Reddit user</div>
        </div>
        <button className={styles.button} onClick={onStart}>
          Cast your vote
        </button>
      </div>
    </div>
  );
}
