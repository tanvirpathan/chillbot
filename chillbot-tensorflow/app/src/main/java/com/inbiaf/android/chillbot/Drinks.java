package com.inbiaf.android.chillbot;

import com.google.firebase.database.IgnoreExtraProperties;

@IgnoreExtraProperties
public class Drinks {

    public Boolean coke;
    public Boolean perrier;
    public Boolean dietCoke;
    public Boolean other;

    public Drinks() {

    }

    public Drinks(Boolean coke, Boolean perrier, Boolean other) {
        this.coke = coke;
        this.perrier = perrier;
        this.other = other;
        dietCoke = false;
    }
}
